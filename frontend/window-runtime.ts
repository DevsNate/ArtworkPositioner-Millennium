type DocumentSubscriber = () => void;

type DocumentRuntime = {
  observer: MutationObserver;
  subscribers: Set<DocumentSubscriber>;
  queued: boolean;
};

const runtimes = new Map<Document, DocumentRuntime>();

export const subscribeToDocument = (targetDocument: Document, subscriber: DocumentSubscriber) => {
  let runtime = runtimes.get(targetDocument);
  if (!runtime) {
    const subscribers = new Set<DocumentSubscriber>();
    runtime = {
      subscribers,
      queued: false,
      observer: new (targetDocument.defaultView?.MutationObserver ?? MutationObserver)(() => {
        const current = runtimes.get(targetDocument);
        if (!current || current.queued) return;
        current.queued = true;
        (targetDocument.defaultView ?? window).queueMicrotask(() => {
          current.queued = false;
          current.subscribers.forEach((callback) => callback());
        });
      }),
    };
    runtimes.set(targetDocument, runtime);
    if (targetDocument.body) {
      runtime.observer.observe(targetDocument.body, { childList: true, subtree: true });
    }
  }

  runtime.subscribers.add(subscriber);
  subscriber();

  return () => {
    const current = runtimes.get(targetDocument);
    if (!current) return;
    current.subscribers.delete(subscriber);
    if (current.subscribers.size === 0) {
      current.observer.disconnect();
      runtimes.delete(targetDocument);
    }
  };
};

export const disposeDocumentRuntimes = () => {
  runtimes.forEach((runtime) => runtime.observer.disconnect());
  runtimes.clear();
};
