// Node executes the real typed core in tests; Forge/Webpack requires extensionless
// source imports. Resolve only those relative TypeScript paths in this test worker.
import { registerHooks } from 'node:module';
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (/^\.{1,2}\/[^.]+$/.test(specifier) && context.parentURL?.endsWith('.ts'))
      return nextResolve(`${specifier}.ts`, context);
    return nextResolve(specifier, context);
  },
});
