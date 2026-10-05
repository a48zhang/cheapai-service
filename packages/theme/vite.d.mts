// Structural plugin typing keeps the adapter usable with both Vite 6 and 8.
export function appearanceBootstrap(): {
  name: string;
  configResolved(config: { base: string }): void;
  configureServer(server: {
    middlewares: {
      use(
        handler: (
          request: { url?: string | undefined },
          response: { setHeader(key: string, value: string): void; end(body: string): void },
          next: () => void,
        ) => void,
      ): void;
    };
  }): void;
  generateBundle(this: {
    emitFile(file: { type: 'asset'; fileName: string; source: string }): unknown;
  }): void;
  transformIndexHtml: {
    order: 'post';
    handler(): { tag: string; attrs: { src: string }; injectTo: 'head-prepend' }[];
  };
};
