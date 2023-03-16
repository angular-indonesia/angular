/**
 * @license
 * Copyright Google LLC All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.io/license
 */

import {ApplicationRef} from '../application_ref';
import {collectNativeNodes} from '../render3/collect_native_nodes';
import {CONTAINER_HEADER_OFFSET, LContainer} from '../render3/interfaces/container';
import {TNode, TNodeType} from '../render3/interfaces/node';
import {RElement} from '../render3/interfaces/renderer_dom';
import {isLContainer, isRootView} from '../render3/interfaces/type_checks';
import {HEADER_OFFSET, HOST, LView, RENDERER, TView, TVIEW, TViewType} from '../render3/interfaces/view';
import {unwrapRNode} from '../render3/util/view_utils';
import {TransferState} from '../transfer_state';

import {CONTAINERS, ELEMENT_CONTAINERS, NUM_ROOT_NODES, SerializedContainerView, SerializedView, TEMPLATE_ID, TEMPLATES} from './interfaces';
import {SKIP_HYDRATION_ATTR_NAME} from './skip_hydration';
import {getComponentLViewForHydration, NGH_ATTR_NAME, NGH_DATA_KEY, TextNodeMarker} from './utils';

/**
 * A collection that tracks all serialized views (`ngh` DOM annotations)
 * to avoid duplication. An attempt to add a duplicate view results in the
 * collection returning the index of the previously collected serialized view.
 * This reduces the number of annotations needed for a given page.
 */
class SerializedViewCollection {
  private views: SerializedView[] = [];
  private indexByContent = new Map<string, number>();

  add(serializedView: SerializedView): number {
    const viewAsString = JSON.stringify(serializedView);
    if (!this.indexByContent.has(viewAsString)) {
      const index = this.views.length;
      this.views.push(serializedView);
      this.indexByContent.set(viewAsString, index);
      return index;
    }
    return this.indexByContent.get(viewAsString)!;
  }

  getAll(): SerializedView[] {
    return this.views;
  }
}

/**
 * Global counter that is used to generate a unique id for TViews
 * during the serialization process.
 */
let tViewSsrId = 0;

/**
 * Generates a unique id for a given TView and returns this id.
 * The id is also stored on this instance of a TView and reused in
 * subsequent calls.
 *
 * This id is needed to uniquely identify and pick up dehydrated views
 * at runtime.
 */
function getSsrId(tView: TView): string {
  if (!tView.ssrId) {
    tView.ssrId = `t${tViewSsrId++}`;
  }
  return tView.ssrId;
}

/**
 * Describes a context available during the serialization
 * process. The context is used to share and collect information
 * during the serialization.
 */
interface HydrationContext {
  serializedViewCollection: SerializedViewCollection;
  corruptedTextNodes: Map<HTMLElement, TextNodeMarker>;
}

/**
 * Computes the number of root nodes in a given view
 * (or child nodes in a given container if a tNode is provided).
 */
function calcNumRootNodes(tView: TView, lView: LView, tNode: TNode|null): number {
  const rootNodes: unknown[] = [];
  collectNativeNodes(tView, lView, tNode, rootNodes);
  return rootNodes.length;
}

/**
 * Annotates all components bootstrapped in a given ApplicationRef
 * with info needed for hydration.
 *
 * @param appRef An instance of an ApplicationRef.
 * @param doc A reference to the current Document instance.
 */
export function annotateForHydration(appRef: ApplicationRef, doc: Document) {
  const serializedViewCollection = new SerializedViewCollection();
  const corruptedTextNodes = new Map<HTMLElement, TextNodeMarker>();
  const viewRefs = appRef._views;
  for (const viewRef of viewRefs) {
    const lView = getComponentLViewForHydration(viewRef);
    // An `lView` might be `null` if a `ViewRef` represents
    // an embedded view (not a component view).
    if (lView !== null) {
      const hostElement = lView[HOST];
      if (hostElement) {
        const context: HydrationContext = {
          serializedViewCollection,
          corruptedTextNodes,
        };
        annotateHostElementForHydration(hostElement as HTMLElement, lView, context);
        insertCorruptedTextNodeMarkers(corruptedTextNodes, doc);
      }
    }
  }
  const allSerializedViews = serializedViewCollection.getAll();
  if (allSerializedViews.length > 0) {
    const transferState = appRef.injector.get(TransferState);
    transferState.set(NGH_DATA_KEY, allSerializedViews);
  }
}

/**
 * Serializes the lContainer data into a list of SerializedView objects,
 * that represent views within this lContainer.
 *
 * @param lContainer the lContainer we are serializing
 * @param context the hydration context
 * @returns an array of the `SerializedView` objects
 */
function serializeLContainer(
    lContainer: LContainer, context: HydrationContext): SerializedContainerView[] {
  const views: SerializedContainerView[] = [];

  for (let i = CONTAINER_HEADER_OFFSET; i < lContainer.length; i++) {
    let childLView = lContainer[i] as LView;

    // If this is a root view, get an LView for the underlying component,
    // because it contains information about the view to serialize.
    if (isRootView(childLView)) {
      childLView = childLView[HEADER_OFFSET];
    }
    const childTView = childLView[TVIEW];

    let template: string;
    let numRootNodes = 0;
    if (childTView.type === TViewType.Component) {
      template = childTView.ssrId!;

      // This is a component view, thus it has only 1 root node: the component
      // host node itself (other nodes would be inside that host node).
      numRootNodes = 1;
    } else {
      template = getSsrId(childTView);
      numRootNodes = calcNumRootNodes(childTView, childLView, childTView.firstChild);
    }

    const view: SerializedContainerView = {
      [TEMPLATE_ID]: template,
      [NUM_ROOT_NODES]: numRootNodes,
      ...serializeLView(lContainer[i] as LView, context),
    };

    views.push(view);
  }
  return views;
}

/**
 * Serializes the lView data into a SerializedView object that will later be added
 * to the TransferState storage and referenced using the `ngh` attribute on a host
 * element.
 *
 * @param lView the lView we are serializing
 * @param context the hydration context
 * @returns the `SerializedView` object containing the data to be added to the host node
 */
function serializeLView(lView: LView, context: HydrationContext): SerializedView {
  const ngh: SerializedView = {};
  const tView = lView[TVIEW];
  // Iterate over DOM element references in an LView.
  for (let i = HEADER_OFFSET; i < tView.bindingStartIndex; i++) {
    const tNode = tView.data[i] as TNode;
    const noOffsetIndex = i - HEADER_OFFSET;
    // Local refs (e.g. <div #localRef>) take up an extra slot in LViews
    // to store the same element. In this case, there is no information in
    // a corresponding slot in TNode data structure. If that's the case, just
    // skip this slot and move to the next one.
    if (!tNode) {
      continue;
    }
    if (isLContainer(lView[i])) {
      // Serialize information about a template.
      const embeddedTView = tNode.tView;
      if (embeddedTView !== null) {
        ngh[TEMPLATES] ??= {};
        ngh[TEMPLATES][noOffsetIndex] = getSsrId(embeddedTView);
      }

      // Serialize views within this LContainer.
      const hostNode = lView[i][HOST]!;  // host node of this container

      // LView[i][HOST] can be of 2 different types:
      // - either a DOM node
      // - or an array that represents an LView of a component
      if (Array.isArray(hostNode)) {
        // This is a component, serialize info about it.
        const targetNode = unwrapRNode(hostNode as LView) as RElement;
        if (!(targetNode as HTMLElement).hasAttribute(SKIP_HYDRATION_ATTR_NAME)) {
          annotateHostElementForHydration(targetNode, hostNode as LView, context);
        }
      }
      ngh[CONTAINERS] ??= {};
      ngh[CONTAINERS][noOffsetIndex] = serializeLContainer(lView[i], context);
    } else if (Array.isArray(lView[i])) {
      // This is a component, annotate the host node with an `ngh` attribute.
      const targetNode = unwrapRNode(lView[i][HOST]!);
      if (!(targetNode as HTMLElement).hasAttribute(SKIP_HYDRATION_ATTR_NAME)) {
        annotateHostElementForHydration(targetNode as RElement, lView[i], context);
      }
    } else {
      // <ng-container> case
      if (tNode.type & TNodeType.ElementContainer) {
        // An <ng-container> is represented by the number of
        // top-level nodes. This information is needed to skip over
        // those nodes to reach a corresponding anchor node (comment node).
        ngh[ELEMENT_CONTAINERS] ??= {};
        ngh[ELEMENT_CONTAINERS][noOffsetIndex] = calcNumRootNodes(tView, lView, tNode.child);
      } else {
        // Handle cases where text nodes can be lost after DOM serialization:
        //  1. When there is an *empty text node* in DOM: in this case, this
        //     node would not make it into the serialized string and as a result,
        //     this node wouldn't be created in a browser. This would result in
        //     a mismatch during the hydration, where the runtime logic would expect
        //     a text node to be present in live DOM, but no text node would exist.
        //     Example: `<span>{{ name }}</span>` when the `name` is an empty string.
        //     This would result in `<span></span>` string after serialization and
        //     in a browser only the `span` element would be created. To resolve that,
        //     an extra comment node is appended in place of an empty text node and
        //     that special comment node is replaced with an empty text node *before*
        //     hydration.
        //  2. When there are 2 consecutive text nodes present in the DOM.
        //     Example: `<div>Hello <ng-container *ngIf="true">world</ng-container></div>`.
        //     In this scenario, the live DOM would look like this:
        //       <div>#text('Hello ') #text('world') #comment('container')</div>
        //     Serialized string would look like this: `<div>Hello world<!--container--></div>`.
        //     The live DOM in a browser after that would be:
        //       <div>#text('Hello world') #comment('container')</div>
        //     Notice how 2 text nodes are now "merged" into one. This would cause hydration
        //     logic to fail, since it'd expect 2 text nodes being present, not one.
        //     To fix this, we insert a special comment node in between those text nodes, so
        //     serialized representation is: `<div>Hello <!--ngtns-->world<!--container--></div>`.
        //     This forces browser to create 2 text nodes separated by a comment node.
        //     Before running a hydration process, this special comment node is removed, so the
        //     live DOM has exactly the same state as it was before serialization.
        if (tNode.type & TNodeType.Text) {
          const rNode = unwrapRNode(lView[i]) as HTMLElement;
          if (rNode.textContent?.replace(/\s/gm, '') === '') {
            context.corruptedTextNodes.set(rNode, TextNodeMarker.EmptyNode);
          } else if (rNode.nextSibling?.nodeType === Node.TEXT_NODE) {
            context.corruptedTextNodes.set(rNode, TextNodeMarker.Separator);
          }
        }
      }
    }
  }
  return ngh;
}

/**
 * Physically adds the `ngh` attribute and serialized data to the host element.
 *
 * @param element The Host element to be annotated
 * @param lView The associated LView
 * @param context The hydration context
 */
function annotateHostElementForHydration(
    element: RElement, lView: LView, context: HydrationContext): void {
  const ngh = serializeLView(lView, context);
  const index = context.serializedViewCollection.add(ngh);
  const renderer = lView[RENDERER];
  renderer.setAttribute(element, NGH_ATTR_NAME, index.toString());
}

/**
 * Physically inserts the comment nodes to ensure empty text nodes and adjacent
 * text node separators are preserved after server serialization of the DOM.
 * These get swapped back for empty text nodes or separators once hydration happens
 * on the client.
 *
 * @param corruptedTextNodes The Map of text nodes to be replaced with comments
 * @param doc The document
 */
function insertCorruptedTextNodeMarkers(
    corruptedTextNodes: Map<HTMLElement, string>, doc: Document) {
  for (const [textNode, marker] of corruptedTextNodes) {
    textNode.after(doc.createComment(marker));
  }
}
