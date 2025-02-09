/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as dom from 'vs/base/browser/dom';
import { IKeyboardEvent } from 'vs/base/browser/keyboardEvent';
import { ActionBar, IActionViewItem } from 'vs/base/browser/ui/actionbar/actionbar';
import { Button } from 'vs/base/browser/ui/button/button';
import { IIdentityProvider, IKeyboardNavigationLabelProvider, IListVirtualDelegate } from 'vs/base/browser/ui/list/list';
import { DefaultKeyboardNavigationDelegate, IListAccessibilityProvider } from 'vs/base/browser/ui/list/listWidget';
import { ObjectTree } from 'vs/base/browser/ui/tree/objectTree';
import { ITreeContextMenuEvent, ITreeEvent, ITreeFilter, ITreeNode, ITreeRenderer, ITreeSorter, TreeFilterResult, TreeVisibility } from 'vs/base/browser/ui/tree/tree';
import { Action, IAction } from 'vs/base/common/actions';
import { RunOnceScheduler } from 'vs/base/common/async';
import { Color, RGBA } from 'vs/base/common/color';
import { Event } from 'vs/base/common/event';
import { FuzzyScore } from 'vs/base/common/filters';
import { splitGlobAware } from 'vs/base/common/glob';
import { Iterable } from 'vs/base/common/iterator';
import { KeyCode } from 'vs/base/common/keyCodes';
import { Disposable, dispose, IDisposable, MutableDisposable } from 'vs/base/common/lifecycle';
import { isDefined } from 'vs/base/common/types';
import { URI } from 'vs/base/common/uri';
import 'vs/css!./media/testing';
import { localize } from 'vs/nls';
import { createAndFillInActionBarActions, MenuEntryActionViewItem } from 'vs/platform/actions/browser/menuEntryActionViewItem';
import { IMenuService, MenuId, MenuItemAction } from 'vs/platform/actions/common/actions';
import { ICommandService } from 'vs/platform/commands/common/commands';
import { IConfigurationService } from 'vs/platform/configuration/common/configuration';
import { IContextKeyService } from 'vs/platform/contextkey/common/contextkey';
import { IContextMenuService } from 'vs/platform/contextview/browser/contextView';
import { FileKind } from 'vs/platform/files/common/files';
import { IInstantiationService } from 'vs/platform/instantiation/common/instantiation';
import { IKeybindingService } from 'vs/platform/keybinding/common/keybinding';
import { WorkbenchObjectTree } from 'vs/platform/list/browser/listService';
import { IOpenerService } from 'vs/platform/opener/common/opener';
import { UnmanagedProgress } from 'vs/platform/progress/common/progress';
import { IStorageService, StorageScope, StorageTarget } from 'vs/platform/storage/common/storage';
import { ITelemetryService } from 'vs/platform/telemetry/common/telemetry';
import { foreground } from 'vs/platform/theme/common/colorRegistry';
import { attachButtonStyler } from 'vs/platform/theme/common/styler';
import { IThemeService, registerThemingParticipant, ThemeIcon } from 'vs/platform/theme/common/themeService';
import { TestResult } from 'vs/workbench/api/common/extHostTypes';
import { IResourceLabel, IResourceLabelOptions, IResourceLabelProps, ResourceLabels } from 'vs/workbench/browser/labels';
import { ViewPane } from 'vs/workbench/browser/parts/views/viewPane';
import { IViewletViewOptions } from 'vs/workbench/browser/parts/views/viewsViewlet';
import { IViewDescriptorService, ViewContainerLocation } from 'vs/workbench/common/views';
import { ITestTreeElement, ITestTreeProjection } from 'vs/workbench/contrib/testing/browser/explorerProjections';
import { HierarchicalByLocationProjection } from 'vs/workbench/contrib/testing/browser/explorerProjections/hierarchalByLocation';
import { HierarchicalByNameProjection } from 'vs/workbench/contrib/testing/browser/explorerProjections/hierarchalByName';
import { testingHiddenIcon, testingStatesToIcons } from 'vs/workbench/contrib/testing/browser/icons';
import { ITestExplorerFilterState, TestExplorerFilterState, TestingExplorerFilter } from 'vs/workbench/contrib/testing/browser/testingExplorerFilter';
import { ITestingPeekOpener } from 'vs/workbench/contrib/testing/browser/testingOutputPeek';
import { ITestingProgressUiService } from 'vs/workbench/contrib/testing/browser/testingProgressUiService';
import { TestExplorerStateFilter, TestExplorerViewMode, TestExplorerViewSorting, Testing, testStateNames } from 'vs/workbench/contrib/testing/common/constants';
import { TestIdPath, TestItemExpandState } from 'vs/workbench/contrib/testing/common/testCollection';
import { TestingContextKeys } from 'vs/workbench/contrib/testing/common/testingContextKeys';
import { cmpPriority, isFailedState } from 'vs/workbench/contrib/testing/common/testingStates';
import { ITestResultService } from 'vs/workbench/contrib/testing/common/testResultService';
import { ITestService } from 'vs/workbench/contrib/testing/common/testService';
import { IWorkspaceTestCollectionService, TestSubscriptionListener } from 'vs/workbench/contrib/testing/common/workspaceTestCollectionService';
import { IEditorService } from 'vs/workbench/services/editor/common/editorService';
import { DebugAction, EditFocusedTest, HideOrShowTestAction, RunAction } from './testExplorerActions';

export class TestingExplorerView extends ViewPane {
	public viewModel!: TestingExplorerViewModel;
	private filterActionBar = this._register(new MutableDisposable());
	private readonly currentSubscription = new MutableDisposable<TestSubscriptionListener>();
	private container!: HTMLElement;
	private discoveryProgress = this._register(new MutableDisposable<UnmanagedProgress>());
	private readonly location = TestingContextKeys.explorerLocation.bindTo(this.contextKeyService);;

	constructor(
		options: IViewletViewOptions,
		@IWorkspaceTestCollectionService private readonly testCollection: IWorkspaceTestCollectionService,
		@ITestService private readonly testService: ITestService,
		@IContextMenuService contextMenuService: IContextMenuService,
		@IKeybindingService keybindingService: IKeybindingService,
		@IConfigurationService configurationService: IConfigurationService,
		@IInstantiationService instantiationService: IInstantiationService,
		@IViewDescriptorService viewDescriptorService: IViewDescriptorService,
		@IContextKeyService contextKeyService: IContextKeyService,
		@IOpenerService openerService: IOpenerService,
		@IThemeService themeService: IThemeService,
		@ITelemetryService telemetryService: ITelemetryService,
		@ITestingProgressUiService private readonly testProgressService: ITestingProgressUiService,
	) {
		super(options, keybindingService, contextMenuService, configurationService, contextKeyService, viewDescriptorService, instantiationService, openerService, themeService, telemetryService);
		this._register(testService.onDidChangeProviders(() => this._onDidChangeViewWelcomeState.fire()));
		this.location.set(viewDescriptorService.getViewLocationById(Testing.ExplorerViewId) ?? ViewContainerLocation.Sidebar);
	}

	/**
	 * @override
	 */
	public shouldShowWelcome() {
		return this.testService.providers === 0;
	}

	/**
	 * @override
	 */
	protected renderBody(container: HTMLElement): void {
		super.renderBody(container);

		this.container = dom.append(container, dom.$('.test-explorer'));

		if (this.location.get() === ViewContainerLocation.Sidebar) {
			this.filterActionBar.value = this.createFilterActionBar();
		}

		const messagesContainer = dom.append(this.container, dom.$('.test-explorer-messages'));
		this._register(this.testProgressService.onTextChange(text => {
			messagesContainer.innerText = text;
		}));

		const progress = new MutableDisposable<UnmanagedProgress>();
		this._register(this.testProgressService.onCountChange(evt => {
			if (!evt.isRunning && progress.value) {
				progress.clear();
			} else if (evt.isRunning) {
				if (!progress.value) {
					progress.value = this.instantiationService.createInstance(UnmanagedProgress, { location: this.getProgressLocation(), total: 100 });
				}
				progress.value.report({ increment: evt.runSoFar, total: evt.totalWillBeRun });
			}
		}));

		const listContainer = dom.append(this.container, dom.$('.test-explorer-tree'));
		this.viewModel = this.instantiationService.createInstance(TestingExplorerViewModel, listContainer, this.onDidChangeBodyVisibility, this.currentSubscription.value);
		this._register(this.viewModel);

		this._register(this.onDidChangeBodyVisibility(visible => {
			if (!visible && this.currentSubscription) {
				this.currentSubscription.value = undefined;
				this.viewModel.replaceSubscription(undefined);
			} else if (visible && !this.currentSubscription.value) {
				this.currentSubscription.value = this.createSubscription();
				this.viewModel.replaceSubscription(this.currentSubscription.value);
			}
		}));
	}

	/**
	 * @override
	 */
	public getActionViewItem(action: IAction): IActionViewItem | undefined {
		if (action.id === Testing.FilterActionId) {
			return this.instantiationService.createInstance(TestingExplorerFilter, action);
		}

		return super.getActionViewItem(action);
	}

	/**
	 * @override
	 */
	public saveState() {
		super.saveState();
	}

	private createFilterActionBar() {
		const bar = new ActionBar(this.container, {
			actionViewItemProvider: action => this.getActionViewItem(action),
			triggerKeys: { keyDown: false, keys: [] },
		});
		bar.push(new Action(Testing.FilterActionId));
		bar.getContainer().classList.add('testing-filter-action-bar');
		return bar;
	}

	private updateDiscoveryProgress(busy: number) {
		if (!busy && this.discoveryProgress) {
			this.discoveryProgress.clear();
		} else if (busy && !this.discoveryProgress.value) {
			this.discoveryProgress.value = this.instantiationService.createInstance(UnmanagedProgress, { location: this.getProgressLocation() });
		}
	}

	/**
	 * @override
	 */
	protected layoutBody(height: number, width: number): void {
		super.layoutBody(height, width);
		this.container.style.height = `${height}px`;
		this.viewModel.layout(height, width);
	}

	private createSubscription() {
		const handle = this.testCollection.subscribeToWorkspaceTests();
		handle.subscription.onBusyProvidersChange(() => this.updateDiscoveryProgress(handle.subscription.busyProviders));
		return handle;
	}
}

class EmptyTestsWidget extends Disposable {
	private readonly el: HTMLElement;
	constructor(
		container: HTMLElement,
		@ICommandService commandService: ICommandService,
		@IThemeService themeService: IThemeService,
	) {
		super();
		const el = this.el = dom.append(container, dom.$('.testing-no-test-placeholder'));
		const emptyParagraph = dom.append(el, dom.$('p'));
		emptyParagraph.innerText = localize('testingNoTest', 'No tests have been found in this workspace yet.');
		const buttonLabel = localize('testingFindExtension', 'Find Test Extensions');
		const button = this._register(new Button(el, { title: buttonLabel }));
		button.label = buttonLabel;
		this._register(attachButtonStyler(button, themeService));
		this._register(button.onDidClick(() => commandService.executeCommand('testing.searchForTestExtension')));
	}

	public setVisible(isVisible: boolean) {
		this.el.classList.toggle('visible', isVisible);
	}
}

export class TestingExplorerViewModel extends Disposable {
	public tree: ObjectTree<ITestTreeElement, FuzzyScore>;
	private filter: TestsFilter;
	public projection = this._register(new MutableDisposable<ITestTreeProjection>());

	private readonly emptyTestsWidget: EmptyTestsWidget;
	private readonly _viewMode = TestingContextKeys.viewMode.bindTo(this.contextKeyService);
	private readonly _viewSorting = TestingContextKeys.viewSorting.bindTo(this.contextKeyService);

	/**
	 * Whether there's a reveal request which has not yet been delivered. This
	 * can happen if the user asks to reveal before the test tree is loaded.
	 * We check to see if the reveal request is present on each tree update,
	 * and do it then if so.
	 */
	private hasPendingReveal = false;

	/**
	 * Fires when the selected tests change.
	 */
	public readonly onDidChangeSelection: Event<ITreeEvent<ITestTreeElement | null>>;

	public get viewMode() {
		return this._viewMode.get() ?? TestExplorerViewMode.Tree;
	}

	public set viewMode(newMode: TestExplorerViewMode) {
		if (newMode === this._viewMode.get()) {
			return;
		}

		this._viewMode.set(newMode);
		this.updatePreferredProjection();
		this.storageService.store('testing.viewMode', newMode, StorageScope.WORKSPACE, StorageTarget.USER);
	}


	public get viewSorting() {
		return this._viewSorting.get() ?? TestExplorerViewSorting.ByLocation;
	}

	public set viewSorting(newSorting: TestExplorerViewSorting) {
		if (newSorting === this._viewSorting.get()) {
			return;
		}

		this._viewSorting.set(newSorting);
		this.tree.resort(null);
		this.storageService.store('testing.viewSorting', newSorting, StorageScope.WORKSPACE, StorageTarget.USER);
	}

	constructor(
		listContainer: HTMLElement,
		onDidChangeVisibility: Event<boolean>,
		private listener: TestSubscriptionListener | undefined,
		@IMenuService private readonly menuService: IMenuService,
		@IContextMenuService private readonly contextMenuService: IContextMenuService,
		@ITestService private readonly testService: ITestService,
		@ITestExplorerFilterState private readonly filterState: TestExplorerFilterState,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IEditorService editorService: IEditorService,
		@IStorageService private readonly storageService: IStorageService,
		@IContextKeyService private readonly contextKeyService: IContextKeyService,
		@ITestResultService private readonly testResults: ITestResultService,
		@ITestingPeekOpener private readonly peekOpener: ITestingPeekOpener,
	) {
		super();

		this.hasPendingReveal = !!filterState.reveal.value;
		this.emptyTestsWidget = this._register(instantiationService.createInstance(EmptyTestsWidget, listContainer));
		this._viewMode.set(this.storageService.get('testing.viewMode', StorageScope.WORKSPACE, TestExplorerViewMode.Tree) as TestExplorerViewMode);
		this._viewSorting.set(this.storageService.get('testing.viewSorting', StorageScope.WORKSPACE, TestExplorerViewSorting.ByLocation) as TestExplorerViewSorting);

		const labels = this._register(instantiationService.createInstance(ResourceLabels, { onDidChangeVisibility: onDidChangeVisibility }));

		this.filter = this.instantiationService.createInstance(TestsFilter);
		this.tree = instantiationService.createInstance(
			WorkbenchObjectTree,
			'Test Explorer List',
			listContainer,
			new ListDelegate(),
			[
				instantiationService.createInstance(TestsRenderer, labels)
			],
			{
				simpleKeyboardNavigation: true,
				identityProvider: instantiationService.createInstance(IdentityProvider),
				hideTwistiesOfChildlessElements: false,
				sorter: instantiationService.createInstance(TreeSorter, this),
				keyboardNavigationLabelProvider: instantiationService.createInstance(TreeKeyboardNavigationLabelProvider),
				accessibilityProvider: instantiationService.createInstance(ListAccessibilityProvider),
				filter: this.filter,
			}) as WorkbenchObjectTree<ITestTreeElement, FuzzyScore>;

		this._register(this.tree.onDidChangeCollapseState(evt => {
			if (evt.node.element) {
				this.projection.value?.expandElement(evt.node.element, evt.deep ? Infinity : 0);
			}
		}));

		this._register(filterState.currentDocumentOnly.onDidChange(() => {
			if (!filterState.currentDocumentOnly.value) {
				this.filter.filterToUri(undefined);
			} else if (editorService.activeEditor?.resource && this.projection.value?.hasTestInDocument(editorService.activeEditor.resource)) {
				this.filter.filterToUri(editorService.activeEditor.resource);
			}

			this.tree.refilter();
		}));

		this._register(this.tree.onContextMenu(e => this.onContextMenu(e)));

		this._register(editorService.onDidActiveEditorChange(() => {
			if (filterState.currentDocumentOnly.value && editorService.activeEditor?.resource) {
				if (this.projection.value?.hasTestInDocument(editorService.activeEditor.resource)) {
					this.filter.filterToUri(editorService.activeEditor.resource);
					this.tree.refilter();
				}
			}
		}));

		this._register(Event.any(
			filterState.text.onDidChange,
			filterState.stateFilter.onDidChange,
			filterState.showExcludedTests.onDidChange,
			testService.excludeTests.onDidChange,
		)(this.tree.refilter, this.tree));

		this._register(this.tree);

		this._register(dom.addStandardDisposableListener(this.tree.getHTMLElement(), 'keydown', evt => {
			if (evt.equals(KeyCode.Enter)) {
				this.handleExecuteKeypress(evt);
			} else if (DefaultKeyboardNavigationDelegate.mightProducePrintableCharacter(evt)) {
				filterState.text.value = evt.browserEvent.key;
				filterState.focusInput();
			}
		}));

		this._register(filterState.reveal.onDidChange(this.revealByIdPath, this));

		this._register(onDidChangeVisibility(visible => {
			if (visible) {
				filterState.focusInput();
			}
		}));

		this.updatePreferredProjection();

		this.onDidChangeSelection = this.tree.onDidChangeSelection;
		this._register(this.tree.onDidChangeSelection(async evt => {
			const selected = evt.elements[0];
			if (selected && evt.browserEvent && selected.expandable === TestItemExpandState.NotExpandable) {
				if (!(await this.tryPeekError(selected)) && selected?.test) {
					this.instantiationService.invokeFunction(accessor => new EditFocusedTest().run(accessor, selected.test!.item, true));
				}
			}
		}));

		this._register(testResults.onResultsChanged(() => {
			this.tree.resort(null);
		}));
	}

	/**
	 * Re-layout the tree.
	 */
	public layout(_height: number, _width: number): void {
		this.tree.layout(); // The tree will measure its container
	}

	/**
	 * Replaces the test listener and recalculates the tree.
	 */
	public replaceSubscription(listener: TestSubscriptionListener | undefined) {
		this.listener = listener;
		this.updatePreferredProjection();
	}

	/**
	 * Tries to reveal by extension ID. Queues the request if the extension
	 * ID is not currently available.
	 */
	private revealByIdPath(idPath: TestIdPath | undefined) {
		if (!idPath) {
			this.hasPendingReveal = false;
			return;
		}

		if (!this.projection.value) {
			return;
		}

		// If the item itself is visible in the tree, show it. Otherwise, expand
		// its closest parent.
		let expandToLevel = 0;
		for (let i = idPath.length - 1; i >= expandToLevel; i--) {
			const element = this.projection.value.getElementByTestId(idPath[i]);
			// Skip all elements that aren't in the tree.
			if (!element || !this.tree.hasElement(element)) {
				continue;
			}

			// If this 'if' is true, we're at the clostest-visible parent to the node
			// we want to expand. Expand that, and then start the loop again because
			// we might already have children for it.
			if (i < idPath.length - 1) {
				this.tree.expand(element);
				expandToLevel = i + 1; // avoid an infinite loop if the test does not exist
				i = idPath.length - 1; // restart the loop since new children may now be visible
				continue;
			}

			// Otherwise, we've arrived!

			// If the node or any of its children are exlcuded, flip on the 'show
			// excluded tests' checkbox automatically.
			for (let n: ITestTreeElement | null = element; n; n = n.parentItem) {
				if (n.test && this.testService.excludeTests.value.has(n.test.item.extId)) {
					this.filterState.showExcludedTests.value = true;
					break;
				}
			}

			this.filterState.reveal.value = undefined;
			this.hasPendingReveal = false;
			this.tree.domFocus();

			setTimeout(() => {
				// Don't scroll to the item if it's already visible
				if (this.tree.getRelativeTop(element) === null) {
					this.tree.reveal(element, 0.5);
				}

				this.tree.setFocus([element]);
				this.tree.setSelection([element]);
			}, 1);

			return;
		}

		// If here, we've expanded all parents we can. Waiting on data to come
		// in to possibly show the revealed test.
		this.hasPendingReveal = true;
	}

	/**
	 * Collapse all items in the tree.
	 */
	public async collapseAll() {
		this.tree.collapseAll();
	}

	/**
	 * Tries to peek the first test error, if the item is in a failed state.
	 */
	private async tryPeekError(item: ITestTreeElement) {
		const lookup = item.test && this.testResults.getStateById(item.test.item.extId);
		return lookup && isFailedState(lookup[1].state.state)
			? this.peekOpener.tryPeekFirstError(lookup[0], lookup[1], { preserveFocus: true })
			: false;
	}

	private onContextMenu(evt: ITreeContextMenuEvent<ITestTreeElement | null>) {
		if (!evt.element) {
			return;
		}

		const actions = getTestItemActions(this.instantiationService, this.contextKeyService, this.menuService, evt.element);
		this.contextMenuService.showContextMenu({
			getAnchor: () => evt.anchor,
			getActions: () => actions.value.secondary,
			getActionsContext: () => evt.element?.test?.item.extId,
			onHide: () => actions.dispose(),
		});
	}

	private handleExecuteKeypress(evt: IKeyboardEvent) {
		const focused = this.tree.getFocus();
		const selected = this.tree.getSelection();
		let targeted: (ITestTreeElement | null)[];
		if (focused.length === 1 && selected.includes(focused[0])) {
			evt.browserEvent?.preventDefault();
			targeted = selected;
		} else {
			targeted = focused;
		}

		const toRun = targeted
			.map(e => e?.test)
			.filter(isDefined)
			.filter(e => e.item.runnable);

		if (toRun.length) {
			this.testService.runTests({
				debug: false,
				tests: toRun.map(t => ({ src: t.src, testId: t.item.extId })),
			});
		}
	}

	private shouldShowEmptyPlaceholder() {
		return !!this.listener
			&& this.listener.subscription.busyProviders === 0
			&& this.listener.subscription.isEmpty;
	}

	private updatePreferredProjection() {
		this.projection.clear();
		if (!this.listener) {
			this.tree.setChildren(null, []);
			return;
		}

		if (this._viewMode.get() === TestExplorerViewMode.List) {
			this.projection.value = this.instantiationService.createInstance(HierarchicalByNameProjection, this.listener);
		} else {
			this.projection.value = this.instantiationService.createInstance(HierarchicalByLocationProjection, this.listener);
		}

		const scheduler = new RunOnceScheduler(() => this.applyProjectionChanges(), 200);
		this.projection.value.onUpdate(() => {
			if (!scheduler.isScheduled()) {
				scheduler.schedule();
			}
		});

		this.applyProjectionChanges();
	}

	private applyProjectionChanges() {
		this.emptyTestsWidget.setVisible(this.shouldShowEmptyPlaceholder());
		this.projection.value?.applyTo(this.tree);

		if (this.hasPendingReveal) {
			this.revealByIdPath(this.filterState.reveal.value);
		}
	}

	/**
	 * Gets the selected tests from the tree.
	 */
	public getSelectedTests() {
		return this.tree.getSelection();
	}
}

const enum FilterResult {
	Exclude,
	Inherit,
	Include,
}

class TestsFilter implements ITreeFilter<ITestTreeElement> {
	private lastText?: string;
	private filters: [include: boolean, value: string][] | undefined;
	private _filterToUri: string | undefined;

	constructor(
		@ITestExplorerFilterState private readonly state: ITestExplorerFilterState,
		@ITestService private readonly testService: ITestService,
	) { }

	/**
	 * Parses and updates the tree filter. Supports lists of patterns that can be !negated.
	 */
	private setFilter(text: string) {
		this.lastText = text;
		text = text.trim();

		if (!text) {
			this.filters = undefined;
			return;
		}

		this.filters = [];
		for (const filter of splitGlobAware(text, ',').map(s => s.trim()).filter(s => !!s.length)) {
			if (filter.startsWith('!')) {
				this.filters.push([false, filter.slice(1).toLowerCase()]);
			} else {
				this.filters.push([true, filter.toLowerCase()]);
			}
		}
	}

	public filterToUri(uri: URI | undefined) {
		this._filterToUri = uri?.toString();
	}

	/**
	 * @inheritdoc
	 */
	public filter(element: ITestTreeElement): TreeFilterResult<void> {
		if (this.state.text.value !== this.lastText) {
			this.setFilter(this.state.text.value);
		}

		if (
			element.test
			&& !this.state.showExcludedTests.value
			&& this.testService.excludeTests.value.has(element.test.item.extId)
		) {
			return TreeVisibility.Hidden;
		}

		switch (Math.min(this.testFilterText(element), this.testLocation(element), this.testState(element))) {
			case FilterResult.Exclude:
				return TreeVisibility.Hidden;
			case FilterResult.Include:
				return TreeVisibility.Visible;
			default:
				return TreeVisibility.Recurse;
		}
	}

	private testState(element: ITestTreeElement): FilterResult {
		switch (this.state.stateFilter.value) {
			case TestExplorerStateFilter.All:
				return FilterResult.Include;
			case TestExplorerStateFilter.OnlyExecuted:
				return element.ownState !== TestResult.Unset ? FilterResult.Include : FilterResult.Inherit;
			case TestExplorerStateFilter.OnlyFailed:
				return isFailedState(element.ownState) ? FilterResult.Include : FilterResult.Inherit;
		}
	}

	private testLocation(element: ITestTreeElement): FilterResult {
		if (!this._filterToUri || !this.state.currentDocumentOnly.value) {
			return FilterResult.Include;
		}

		for (let e: ITestTreeElement | null = element; e; e = e!.parentItem) {
			return e.uri.toString() === this._filterToUri
				? FilterResult.Include
				: FilterResult.Exclude;
		}

		return FilterResult.Inherit;
	}

	private testFilterText(element: ITestTreeElement) {
		if (!this.filters) {
			return FilterResult.Include;
		}

		for (let e: ITestTreeElement | null = element; e; e = e.parentItem) {
			// start as included if the first glob is a negation
			let included = this.filters[0][0] === false ? FilterResult.Include : FilterResult.Inherit;
			const data = e.label.toLowerCase();

			for (const [include, filter] of this.filters) {
				if (data.includes(filter)) {
					included = include ? FilterResult.Include : FilterResult.Exclude;
				}
			}

			if (included !== FilterResult.Inherit) {
				return included;
			}
		}

		return FilterResult.Inherit;
	}
}

class TreeSorter implements ITreeSorter<ITestTreeElement> {
	constructor(private readonly viewModel: TestingExplorerViewModel) { }

	public compare(a: ITestTreeElement, b: ITestTreeElement): number {
		let delta = cmpPriority(a.state, b.state);
		if (delta !== 0) {
			return delta;
		}

		if (this.viewModel.viewSorting === TestExplorerViewSorting.ByLocation && a.range && b.range && a.uri.toString() === b.uri.toString()) {
			delta = a.range.startLineNumber - b.range.startLineNumber;
			if (delta !== 0) {
				return delta;
			}
		}

		return a.label.localeCompare(b.label);
	}
}

const getLabelForTestTreeElement = (element: ITestTreeElement) => {
	let label = localize({
		key: 'testing.treeElementLabel',
		comment: ['label then the unit tests state, for example "Addition Tests (Running)"'],
	}, '{0} ({1})', element.label, testStateNames[element.state]);

	if (element.retired) {
		label = localize({
			key: 'testing.treeElementLabelOutdated',
			comment: ['{0} is the original label in testing.treeElementLabel'],
		}, '{0}, outdated result', label, testStateNames[element.state]);
	}

	return label;
};

class ListAccessibilityProvider implements IListAccessibilityProvider<ITestTreeElement> {
	getWidgetAriaLabel(): string {
		return localize('testExplorer', "Test Explorer");
	}

	getAriaLabel(element: ITestTreeElement): string {
		return getLabelForTestTreeElement(element);
	}
}

class TreeKeyboardNavigationLabelProvider implements IKeyboardNavigationLabelProvider<ITestTreeElement> {
	getKeyboardNavigationLabel(element: ITestTreeElement) {
		return element.label;
	}
}

class ListDelegate implements IListVirtualDelegate<ITestTreeElement> {
	getHeight(_element: ITestTreeElement) {
		return 22;
	}

	getTemplateId(_element: ITestTreeElement) {
		return TestsRenderer.ID;
	}
}

class IdentityProvider implements IIdentityProvider<ITestTreeElement> {
	public getId(element: ITestTreeElement) {
		return element.treeId;
	}
}

interface TestTemplateData {
	label: IResourceLabel;
	icon: HTMLElement;
	wrapper: HTMLElement;
	actionBar: ActionBar;
	elementDisposable: IDisposable[];
	templateDisposable: IDisposable[];
}

class TestsRenderer extends Disposable implements ITreeRenderer<ITestTreeElement, FuzzyScore, TestTemplateData> {
	public static readonly ID = 'testExplorer';

	constructor(
		private labels: ResourceLabels,
		@IMenuService private readonly menuService: IMenuService,
		@IContextKeyService private readonly contextKeyService: IContextKeyService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@ITestService private readonly testService: ITestService
	) {
		super();
	}

	/**
	 * @inheritdoc
	 */
	get templateId(): string {
		return TestsRenderer.ID;
	}

	/**
	 * @inheritdoc
	 */
	public renderTemplate(container: HTMLElement): TestTemplateData {
		const wrapper = dom.append(container, dom.$('.test-item'));

		const icon = dom.append(wrapper, dom.$('.computed-state'));
		const name = dom.append(wrapper, dom.$('.name'));
		const label = this.labels.create(name, { supportHighlights: true });

		dom.append(wrapper, dom.$(ThemeIcon.asCSSSelector(testingHiddenIcon)));
		const actionBar = new ActionBar(wrapper, {
			actionViewItemProvider: action =>
				action instanceof MenuItemAction
					? this.instantiationService.createInstance(MenuEntryActionViewItem, action)
					: undefined
		});

		return { wrapper, label, actionBar, icon, elementDisposable: [], templateDisposable: [label, actionBar] };
	}

	/**
	 * @inheritdoc
	 */
	public renderElement({ element }: ITreeNode<ITestTreeElement, FuzzyScore>, _: number, data: TestTemplateData): void {
		const label: IResourceLabelProps = { name: element.label };
		const options: IResourceLabelOptions = {};
		data.actionBar.clear();

		const testHidden = !!element.test && this.testService.excludeTests.value.has(element.test.item.extId);
		data.wrapper.classList.toggle('test-is-hidden', testHidden);

		const icon = testingStatesToIcons.get(element.expandable === TestItemExpandState.BusyExpanding ? TestResult.Running : element.state);
		data.icon.className = 'computed-state ' + (icon ? ThemeIcon.asClassName(icon) : '');
		if (element.retired) {
			data.icon.className += ' retired';
		}

		const test = element.test;
		if (test) {
			label.resource = test.item.uri;
			options.title = getLabelForTestTreeElement(element);
			options.fileKind = FileKind.FILE;
			label.description = element.description;
		} else {
			options.fileKind = FileKind.ROOT_FOLDER;
		}

		this.fillActionBar(element, data);
		data.label.setResource(label, options);
	}

	/**
	 * @inheritdoc
	 */
	disposeTemplate(templateData: TestTemplateData): void {
		dispose(templateData.templateDisposable);
		templateData.templateDisposable = [];
	}

	/**
	 * @inheritdoc
	 */
	disposeElement(_element: ITreeNode<ITestTreeElement, FuzzyScore>, _: number, templateData: TestTemplateData): void {
		dispose(templateData.elementDisposable);
		templateData.elementDisposable = [];
	}

	private fillActionBar(element: ITestTreeElement, data: TestTemplateData) {
		const actions = getTestItemActions(this.instantiationService, this.contextKeyService, this.menuService, element);
		data.elementDisposable.push(actions);
		data.actionBar.clear();
		data.actionBar.push(actions.value.primary, { icon: true, label: false });
	}
}

const getTestItemActions = (
	instantionService: IInstantiationService,
	contextKeyService: IContextKeyService,
	menuService: IMenuService,
	element: ITestTreeElement,
) => {
	const contextOverlay = contextKeyService.createOverlay([
		['view', Testing.ExplorerViewId],
		[TestingContextKeys.testItemExtId.key, element.test?.item.extId]
	]);
	const menu = menuService.createMenu(MenuId.TestItem, contextOverlay);

	try {
		const primary: IAction[] = [];
		const secondary: IAction[] = [];
		const running = element.state === TestResult.Running;
		if (!Iterable.isEmpty(element.runnable)) {
			const run = instantionService.createInstance(RunAction, element.runnable, running);
			primary.push(run);
			secondary.push(run);
		}

		if (!Iterable.isEmpty(element.debuggable)) {
			const debug = instantionService.createInstance(DebugAction, element.debuggable, running);
			primary.push(debug);
			secondary.push(debug);
		}

		if (element.test) {
			secondary.push(instantionService.createInstance(HideOrShowTestAction, element.test.item.extId));
		}

		const result = { primary, secondary };
		const actionsDisposable = createAndFillInActionBarActions(menu, {
			arg: element.test?.item,
			shouldForwardArgs: true,
		}, result, 'inline');

		return { value: result, dispose: () => actionsDisposable.dispose };
	} finally {
		menu.dispose();
	}
};


registerThemingParticipant((theme, collector) => {
	if (theme.type === 'dark') {
		const foregroundColor = theme.getColor(foreground);
		if (foregroundColor) {
			const fgWithOpacity = new Color(new RGBA(foregroundColor.rgba.r, foregroundColor.rgba.g, foregroundColor.rgba.b, 0.65));
			collector.addRule(`.test-explorer .test-explorer-messages { color: ${fgWithOpacity}; }`);
		}
	}
});
