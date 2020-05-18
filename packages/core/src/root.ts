import {RemoteComponentType} from '@remote-ui/types';
import {
  Action,
  Serialized,
  RemoteRoot,
  RemoteText,
  RemoteChannel,
  RemoteComponent,
} from './types';

export interface Options<
  AllowedComponents extends RemoteComponentType<any, any>
> {
  readonly components: readonly AllowedComponents[];
}

export function createRemoteRoot<
  AllowedComponents extends RemoteComponentType<any, any> = RemoteComponentType<
    any,
    any
  >,
  AllowedChildrenTypes extends AllowedComponents | boolean = true
>(
  channel: RemoteChannel,
  _options: Options<AllowedComponents>,
): RemoteRoot<AllowedComponents, AllowedChildrenTypes> {
  type Root = RemoteRoot<AllowedComponents, AllowedChildrenTypes>;
  type Component = RemoteComponent<AllowedComponents, Root>;
  type Text = RemoteText<Root>;
  type HasChildren = Root | Component;
  type CanBeChild = Component | Text;

  const parents = new WeakMap<CanBeChild, HasChildren>();
  const children = new WeakMap<HasChildren, readonly CanBeChild[]>();
  const props = new WeakMap<Component, any>();
  const texts = new WeakMap<Text, string>();
  const tops = new WeakMap<CanBeChild, HasChildren>();

  let currentId = 0;

  const remoteRoot: Root = {
    get children() {
      return children.get(remoteRoot) as any;
    },
    createComponent(type, ...propsPart) {
      const [initialProps = {} as any] = propsPart;
      const id = `${currentId++}`;

      const component: RemoteComponent<AllowedComponents, Root> = {
        get children() {
          return children.get(component);
        },
        get props() {
          return props.get(component)!;
        },
        updateProps: (newProps) => updateProps(component, newProps),
        appendChild: (child) => appendChild(component, child),
        removeChild: (child) => removeChild(component, child),
        insertChildBefore: (child, before) =>
          insertChildBefore(component, child, before),
        // Just satisfying the type definition, since we need to write
        // some properties manually, which we do below. If we just `as any`
        // the whole object, we lose the implicit argument types for the
        // methods above.
        ...({} as any),
      };

      Reflect.defineProperty(component, 'type', {
        value: type,
        configurable: false,
        writable: false,
        enumerable: true,
      });

      makePartOfTree(component);
      makeRemote(component, id, remoteRoot);
      props.set(component, initialProps ?? ({} as any));
      children.set(component, []);

      return (component as unknown) as RemoteComponent<typeof type, Root>;
    },
    createText(content = '') {
      const id = `${currentId++}`;

      const text: RemoteText<Root> = {
        get text() {
          return texts.get(text)!;
        },
        updateText: (newText) => updateText(text, newText),
        // Just satisfying the type definition, since we need to write
        // some properties manually.
        ...({} as any),
      };

      makePartOfTree(text);
      makeRemote(text, id, remoteRoot);
      texts.set(text, content);

      return text;
    },
    appendChild: (child) => appendChild(remoteRoot, child),
    removeChild: (child) => removeChild(remoteRoot, child),
    insertChildBefore: (child, before) =>
      insertChildBefore(remoteRoot, child, before),
    async mount() {
      await channel(Action.Mount, children.get(remoteRoot)!.map(serialize));
    },
  };

  children.set(remoteRoot, []);

  return remoteRoot;

  function connected(element: CanBeChild) {
    return tops.get(element) === remoteRoot;
  }

  function allDescendants(
    element: CanBeChild,
    withEach: (item: CanBeChild) => void,
  ) {
    const recurse = (element: CanBeChild) => {
      if ('children' in element) {
        for (const child of element.children) {
          withEach(child);
          recurse(child);
        }
      }
    };

    recurse(element);
  }

  function perform(
    element: Text | Component | Root,
    {
      remote,
      local,
    }: {
      remote(channel: RemoteChannel): void | Promise<void>;
      local(): void;
    },
  ) {
    if (element === remoteRoot || connected(element as any)) {
      // should only create context once async queue is cleared
      remote(channel);

      // technically, we should be waiting for the remote update to apply,
      // then apply it locally. The implementation below is too naive because
      // it allows local updates to get out of sync with remote ones.
      // if (remoteResult == null || !('then' in remoteResult)) {
      //   local();
      //   return;
      // } else {
      //   return remoteResult.then(() => {
      //     local();
      //   });
      // }
    }

    local();
  }

  function updateText(text: Text, newText: string) {
    return perform(text, {
      remote: (channel) => channel(Action.UpdateText, text.id, newText),
      local: () => texts.set(text, newText),
    });
  }

  function updateProps(component: Component, newProps: any) {
    return perform(component, {
      remote: (channel) => channel(Action.UpdateProps, component.id, newProps),
      local: () => {
        props.set(
          component,
          Object.freeze({...props.get(component), ...newProps}),
        );
      },
    });
  }

  function appendChild(container: HasChildren, child: CanBeChild | string) {
    const normalizedChild =
      typeof child === 'string' ? remoteRoot.createText(child) : child;

    return perform(container, {
      remote: (channel) =>
        channel(
          Action.InsertChild,
          (container as any).id,
          container.children.length,
          serialize(normalizedChild),
        ),
      local: () => {
        const newTop =
          container === remoteRoot ? remoteRoot : tops.get(container as any)!;

        parents.set(normalizedChild, container);
        tops.set(normalizedChild, newTop);
        allDescendants(normalizedChild, (descendant) =>
          tops.set(descendant, newTop),
        );

        children.set(
          container,
          Object.freeze([...(children.get(container) ?? []), normalizedChild]),
        );
      },
    });
  }

  // there is a problem with this, because when multiple children
  // are removed, there is no guarantee the messages will arrive in the
  // order we need them to on the host side (it depends how React
  // calls our reconciler). If it calls with, for example, the removal of
  // the second last item, then the removal of the last item, it will fail
  // because the indexes moved around.
  //
  // Might need to send the removed child ID, or find out if we
  // can collect removals into a single update.
  function removeChild(container: HasChildren, child: CanBeChild) {
    return perform(container, {
      remote: (channel) =>
        channel(
          Action.RemoveChild,
          (container as any).id,
          container.children.indexOf(child as any),
        ),
      local: () => {
        parents.delete(child);
        allDescendants(child, (descendant) =>
          tops.set(descendant, child as any),
        );

        const newChildren = [...(children.get(container) ?? [])];
        newChildren.splice(newChildren.indexOf(child as any), 1);
        children.set(container, Object.freeze(newChildren));
      },
    });
  }

  function insertChildBefore(
    container: HasChildren,
    child: CanBeChild,
    before: CanBeChild,
  ) {
    return perform(container, {
      remote: (channel) =>
        channel(
          Action.InsertChild,
          (container as any).id,
          container.children.indexOf(before as any),
          serialize(child),
        ),
      local: () => {
        const newTop =
          container === remoteRoot ? remoteRoot : tops.get(container as any)!;

        tops.set(child, newTop);
        parents.set(child, container);
        allDescendants(child, (descendant) => tops.set(descendant, newTop));

        const newChildren = [...(children.get(container) || [])];
        newChildren.splice(newChildren.indexOf(before as any), 0, child);
        children.set(container, Object.freeze(newChildren));
      },
    });
  }

  function makePartOfTree(value: CanBeChild) {
    Reflect.defineProperty(value, 'parent', {
      get() {
        return parents.get(value);
      },
      configurable: true,
      enumerable: true,
    });

    Reflect.defineProperty(value, 'top', {
      get() {
        return tops.get(value);
      },
      configurable: true,
      enumerable: true,
    });
  }

  function serialize(value: Text | Component): Serialized<typeof value> {
    return 'text' in value
      ? {id: value.id, text: value.text}
      : {
          id: value.id,
          type: value.type,
          props: value.props,
          children: value.children.map((child) => serialize(child as any)),
        };
  }
}

function makeRemote<Root extends RemoteRoot<any, any>>(
  value: RemoteText<Root> | RemoteComponent<any, Root>,
  id: string,
  root: Root,
) {
  Reflect.defineProperty(value, 'id', {
    value: id,
    configurable: true,
    writable: false,
    enumerable: false,
  });

  Reflect.defineProperty(value, 'root', {
    value: root,
    configurable: true,
    writable: false,
    enumerable: false,
  });
}
