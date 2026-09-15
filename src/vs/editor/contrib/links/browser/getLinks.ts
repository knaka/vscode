/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { coalesce } from '../../../../base/common/arrays.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { onUnexpectedExternalError } from '../../../../base/common/errors.js';
import { DisposableStore, isDisposable } from '../../../../base/common/lifecycle.js';
import { assertType } from '../../../../base/common/types.js';
import { URI } from '../../../../base/common/uri.js';
import { IRange, Range } from '../../../common/core/range.js';
import { ITextModel } from '../../../common/model.js';
import { ILink, ILinksList, LinkProvider } from '../../../common/languages.js';
import { IModelService } from '../../../common/services/model.js';
import { CommandsRegistry } from '../../../../platform/commands/common/commands.js';
import { LanguageFeatureRegistry } from '../../../common/languageFeatureRegistry.js';
import { ILanguageFeaturesService } from '../../../common/services/languageFeatures.js';

export class Link implements ILink {

	private _link: ILink;
	private readonly _provider: LinkProvider;

	/**
	 * Higher value means higher priority (i.e. the provider that should win when its
	 * range intersects or touches a link from a lower-priority provider).
	 */
	readonly priority: number;

	constructor(link: ILink, provider: LinkProvider, priority: number) {
		this._link = link;
		this._provider = provider;
		this.priority = priority;
	}

	toJSON(): ILink {
		return {
			range: this.range,
			url: this.url,
			tooltip: this.tooltip
		};
	}

	get range(): IRange {
		return this._link.range;
	}

	get url(): URI | string | undefined {
		return this._link.url;
	}

	get tooltip(): string | undefined {
		return this._link.tooltip;
	}

	async resolve(token: CancellationToken): Promise<URI | string> {
		if (this._link.url) {
			return this._link.url;
		}

		if (typeof this._provider.resolveLink === 'function') {
			return Promise.resolve(this._provider.resolveLink(this._link, token)).then(value => {
				this._link = value || this._link;
				if (this._link.url) {
					// recurse
					return this.resolve(token);
				}

				return Promise.reject(new Error('missing'));
			});
		}

		return Promise.reject(new Error('missing'));
	}
}

export class LinksList {

	static readonly Empty = new LinksList([]);

	readonly links: Link[];

	private readonly _disposables: DisposableStore | undefined = new DisposableStore();

	constructor(tuples: [ILinksList, LinkProvider][]) {

		let links: Link[] = [];
		let priority = 0;
		for (const [list, provider] of tuples) {
			// merge all links. `tuples` is ordered from lowest to highest priority
			// provider, so its index doubles as a priority: later (== higher priority)
			// providers should win over earlier ones when ranges overlap.
			const newLinks = list.links.map(link => new Link(link, provider, priority));
			links = LinksList._union(links, newLinks);
			priority++;
			// register disposables
			if (isDisposable(list)) {
				this._disposables ??= new DisposableStore();
				this._disposables.add(list);
			}
		}
		this.links = LinksList._resolveOverlaps(links);
	}

	dispose(): void {
		this._disposables?.dispose();
		this.links.length = 0;
	}

	private static _union(oldLinks: Link[], newLinks: Link[]): Link[] {
		// reunite oldLinks with newLinks and remove duplicates
		const result: Link[] = [];
		let oldIndex: number;
		let oldLen: number;
		let newIndex: number;
		let newLen: number;

		for (oldIndex = 0, newIndex = 0, oldLen = oldLinks.length, newLen = newLinks.length; oldIndex < oldLen && newIndex < newLen;) {
			const oldLink = oldLinks[oldIndex];
			const newLink = newLinks[newIndex];

			if (Range.areIntersectingOrTouching(oldLink.range, newLink.range)) {
				// Remove the oldLink
				oldIndex++;
				continue;
			}

			const comparisonResult = Range.compareRangesUsingStarts(oldLink.range, newLink.range);

			if (comparisonResult < 0) {
				// oldLink is before
				result.push(oldLink);
				oldIndex++;
			} else {
				// newLink is before
				result.push(newLink);
				newIndex++;
			}
		}

		for (; oldIndex < oldLen; oldIndex++) {
			result.push(oldLinks[oldIndex]);
		}
		for (; newIndex < newLen; newIndex++) {
			result.push(newLinks[newIndex]);
		}

		return result;
	}

	private static _resolveOverlaps(links: Link[]): Link[] {
		if (links.length <= 1) {
			return links;
		}

		// Sort by range start; for links that start at the same position, higher
		// priority first so it's the one considered "kept" below.
		const sorted = links.slice().sort((a, b) => {
			const rangeResult = Range.compareRangesUsingStarts(a.range, b.range);
			return rangeResult !== 0 ? rangeResult : (b.priority - a.priority);
		});

		const result: Link[] = [];
		for (const link of sorted) {
			const kept = result[result.length - 1];
			if (kept && Range.areIntersectingOrTouching(kept.range, link.range)) {
				if (link.priority > kept.priority) {
					result[result.length - 1] = link;
				}
				// else: lower (or equal) priority than what's already kept for this
				// span, so drop it.
				continue;
			}
			result.push(link);
		}

		return result;
	}

}

export async function getLinks(providers: LanguageFeatureRegistry<LinkProvider>, model: ITextModel, token: CancellationToken): Promise<LinksList> {
	const lists: [ILinksList, LinkProvider][] = [];

	// ask all providers for links in parallel
	const promises = providers.ordered(model).reverse().map(async (provider, i) => {
		try {
			const result = await provider.provideLinks(model, token);
			if (result) {
				lists[i] = [result, provider];
			}
		} catch (err) {
			onUnexpectedExternalError(err);
		}
	});

	await Promise.all(promises);

	let res = new LinksList(coalesce(lists));

	if (token.isCancellationRequested) {
		res.dispose();
		res = LinksList.Empty;
	}

	return res;
}


CommandsRegistry.registerCommand('_executeLinkProvider', async (accessor, ...args): Promise<ILink[]> => {
	let [uri, resolveCount] = args;
	assertType(uri instanceof URI);

	if (typeof resolveCount !== 'number') {
		resolveCount = 0;
	}

	const { linkProvider } = accessor.get(ILanguageFeaturesService);
	const model = accessor.get(IModelService).getModel(uri);
	if (!model) {
		return [];
	}
	const list = await getLinks(linkProvider, model, CancellationToken.None);
	if (!list) {
		return [];
	}

	// resolve links
	for (let i = 0; i < Math.min(resolveCount as number, list.links.length); i++) {
		await list.links[i].resolve(CancellationToken.None);
	}

	const result = list.links.slice(0);
	list.dispose();
	return result;
});
