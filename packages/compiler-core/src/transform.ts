import {
  RootNode,
  NodeTypes,
  ParentNode,
  TemplateChildNode,
  ElementNode,
  DirectiveNode,
  Property,
  ExpressionNode,
  createSimpleExpression,
  JSChildNode,
  SimpleExpressionNode,
  ElementTypes
} from './ast'
import { isString, isArray } from '@vue/shared'
import { CompilerError, defaultOnError } from './errors'
import { TO_STRING, COMMENT, CREATE_VNODE, FRAGMENT } from './runtimeConstants'
import { isVSlot, createBlockExpression, isSlotOutlet } from './utils'
import { hoistStatic } from './transforms/hoistStatic'

// There are two types of transforms:
//
// - NodeTransform:
//   Transforms that operate directly on a ChildNode. NodeTransforms may mutate,
//   replace or remove the node being processed.
export type NodeTransform = (
  node: RootNode | TemplateChildNode,
  context: TransformContext
) => void | (() => void) | (() => void)[]

// - DirectiveTransform:
//   Transforms that handles a single directive attribute on an element.
//   It translates the raw directive into actual props for the VNode.
export type DirectiveTransform = (
  dir: DirectiveNode,
  context: TransformContext
) => {
  props: Property | Property[]
  needRuntime: boolean
}

// A structural directive transform is a techically a NodeTransform;
// Only v-if and v-for fall into this category.
export type StructuralDirectiveTransform = (
  node: ElementNode,
  dir: DirectiveNode,
  context: TransformContext
) => void | (() => void)

export interface TransformOptions {
  nodeTransforms?: NodeTransform[]
  directiveTransforms?: { [name: string]: DirectiveTransform }
  prefixIdentifiers?: boolean
  hoistStatic?: boolean
  onError?: (error: CompilerError) => void
}

export interface TransformContext extends Required<TransformOptions> {
  root: RootNode
  imports: Set<string>
  statements: Set<string>
  hoists: JSChildNode[]
  identifiers: { [name: string]: number | undefined }
  scopes: {
    vFor: number
    vSlot: number
    vPre: number
    vOnce: number
  }
  parent: ParentNode | null
  childIndex: number
  currentNode: RootNode | TemplateChildNode | null
  helper(name: string): string
  replaceNode(node: TemplateChildNode): void
  removeNode(node?: TemplateChildNode): void
  onNodeRemoved: () => void
  addIdentifiers(exp: ExpressionNode | string): void
  removeIdentifiers(exp: ExpressionNode | string): void
  hoist(exp: JSChildNode): SimpleExpressionNode
}

function createTransformContext(
  root: RootNode,
  {
    prefixIdentifiers = false,
    hoistStatic = false,
    nodeTransforms = [],
    directiveTransforms = {},
    onError = defaultOnError
  }: TransformOptions
): TransformContext {
  const context: TransformContext = {
    root,
    imports: new Set(),
    statements: new Set(),
    hoists: [],
    identifiers: {},
    scopes: {
      vFor: 0,
      vSlot: 0,
      vPre: 0,
      vOnce: 0
    },
    prefixIdentifiers,
    hoistStatic,
    nodeTransforms,
    directiveTransforms,
    onError,
    parent: null,
    currentNode: root,
    childIndex: 0,
    helper(name) {
      context.imports.add(name)
      return prefixIdentifiers ? name : `_${name}`
    },
    replaceNode(node) {
      /* istanbul ignore if */
      if (__DEV__) {
        if (!context.currentNode) {
          throw new Error(`Node being replaced is already removed.`)
        }
        if (!context.parent) {
          throw new Error(`Cannot replace root node.`)
        }
      }
      context.parent!.children[context.childIndex] = context.currentNode = node
    },
    removeNode(node) {
      if (__DEV__ && !context.parent) {
        throw new Error(`Cannot remove root node.`)
      }
      const list = context.parent!.children
      const removalIndex = node
        ? list.indexOf(node as any)
        : context.currentNode
          ? context.childIndex
          : -1
      /* istanbul ignore if */
      if (__DEV__ && removalIndex < 0) {
        throw new Error(`node being removed is not a child of current parent`)
      }
      if (!node || node === context.currentNode) {
        // current node removed
        context.currentNode = null
        context.onNodeRemoved()
      } else {
        // sibling node removed
        if (context.childIndex > removalIndex) {
          context.childIndex--
          context.onNodeRemoved()
        }
      }
      context.parent!.children.splice(removalIndex, 1)
    },
    onNodeRemoved: () => {},
    addIdentifiers(exp) {
      // identifier tracking only happens in non-browser builds.
      if (!__BROWSER__) {
        if (isString(exp)) {
          addId(exp)
        } else if (exp.identifiers) {
          exp.identifiers.forEach(addId)
        } else if (exp.type === NodeTypes.SIMPLE_EXPRESSION) {
          addId(exp.content)
        }
      }
    },
    removeIdentifiers(exp) {
      if (!__BROWSER__) {
        if (isString(exp)) {
          removeId(exp)
        } else if (exp.identifiers) {
          exp.identifiers.forEach(removeId)
        } else if (exp.type === NodeTypes.SIMPLE_EXPRESSION) {
          removeId(exp.content)
        }
      }
    },
    hoist(exp) {
      context.hoists.push(exp)
      return createSimpleExpression(
        `_hoisted_${context.hoists.length}`,
        false,
        exp.loc
      )
    }
  }

  function addId(id: string) {
    const { identifiers } = context
    if (identifiers[id] === undefined) {
      identifiers[id] = 0
    }
    ;(identifiers[id] as number)++
  }

  function removeId(id: string) {
    ;(context.identifiers[id] as number)--
  }

  return context
}

export function transform(root: RootNode, options: TransformOptions) {
  const context = createTransformContext(root, options)
  traverseNode(root, context)
  if (options.hoistStatic) {
    hoistStatic(root, context)
  }
  finalizeRoot(root, context)
}

function finalizeRoot(root: RootNode, context: TransformContext) {
  const { helper } = context
  const { children } = root
  if (children.length === 1) {
    const child = children[0]
    if (
      child.type === NodeTypes.ELEMENT &&
      !isSlotOutlet(child) &&
      child.codegenNode &&
      child.codegenNode.type === NodeTypes.JS_CALL_EXPRESSION
    ) {
      // turn root element into a block
      root.codegenNode = createBlockExpression(
        child.codegenNode!.arguments,
        context
      )
    } else {
      // - single <slot/>, IfNode, ForNode: already blocks.
      // - single text node: always patched.
      // - transform calls without transformElement (only during tests)
      // Just generate the node as-is
      root.codegenNode = child
    }
  } else if (children.length > 1) {
    // root has multiple nodes - return a fragment block.
    root.codegenNode = createBlockExpression(
      [helper(FRAGMENT), `null`, root.children],
      context
    )
  }

  // finalize meta information
  root.imports = [...context.imports]
  root.statements = [...context.statements]
  root.hoists = context.hoists
}

export function traverseChildren(
  parent: ParentNode,
  context: TransformContext
) {
  let i = 0
  const nodeRemoved = () => {
    i--
  }
  for (; i < parent.children.length; i++) {
    const child = parent.children[i]
    if (isString(child)) continue
    context.currentNode = child
    context.parent = parent
    context.childIndex = i
    context.onNodeRemoved = nodeRemoved
    traverseNode(child, context)
  }
}

export function traverseNode(
  node: RootNode | TemplateChildNode,
  context: TransformContext
) {
  // apply transform plugins
  const { nodeTransforms } = context
  const exitFns = []
  for (let i = 0; i < nodeTransforms.length; i++) {
    const onExit = nodeTransforms[i](node, context)
    if (onExit) {
      if (isArray(onExit)) {
        exitFns.push(...onExit)
      } else {
        exitFns.push(onExit)
      }
    }
    if (!context.currentNode) {
      // node was removed
      return
    } else {
      // node may have been replaced
      node = context.currentNode
    }
  }

  switch (node.type) {
    case NodeTypes.COMMENT:
      // inject import for the Comment symbol, which is needed for creating
      // comment nodes with `createVNode`
      context.helper(CREATE_VNODE)
      context.helper(COMMENT)
      break
    case NodeTypes.INTERPOLATION:
      // no need to traverse, but we need to inject toString helper
      context.helper(TO_STRING)
      break

    // for container types, further traverse downwards
    case NodeTypes.IF:
      for (let i = 0; i < node.branches.length; i++) {
        traverseChildren(node.branches[i], context)
      }
      break
    case NodeTypes.FOR:
    case NodeTypes.ELEMENT:
    case NodeTypes.ROOT:
      traverseChildren(node, context)
      break
  }

  // exit transforms
  for (let i = 0; i < exitFns.length; i++) {
    exitFns[i]()
  }
}

export function createStructuralDirectiveTransform(
  name: string | RegExp,
  fn: StructuralDirectiveTransform
): NodeTransform {
  const matches = isString(name)
    ? (n: string) => n === name
    : (n: string) => name.test(n)

  return (node, context) => {
    if (node.type === NodeTypes.ELEMENT) {
      const { props } = node
      // structural directive transforms are not concerned with slots
      // as they are handled separately in vSlot.ts
      if (node.tagType === ElementTypes.TEMPLATE && props.some(isVSlot)) {
        return
      }
      const exitFns = []
      for (let i = 0; i < props.length; i++) {
        const prop = props[i]
        if (prop.type === NodeTypes.DIRECTIVE && matches(prop.name)) {
          // structural directives are removed to avoid infinite recursion
          // also we remove them *before* applying so that it can further
          // traverse itself in case it moves the node around
          props.splice(i, 1)
          i--
          const onExit = fn(node, prop, context)
          if (onExit) exitFns.push(onExit)
        }
      }
      return exitFns
    }
  }
}
