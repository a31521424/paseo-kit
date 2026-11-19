// Lets `node --test` run the plugin's TypeScript sources as they are: Node strips the types, and
// this hook resolves the extensionless relative imports the bundler accepts (`../shared/limits`).
import { registerHooks } from "node:module";

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (!specifier.startsWith(".") || /\.[cm]?[jt]sx?$/.test(specifier)) {
      return nextResolve(specifier, context);
    }
    try {
      return nextResolve(`${specifier}.ts`, context);
    } catch {
      return nextResolve(specifier, context);
    }
  },
});
