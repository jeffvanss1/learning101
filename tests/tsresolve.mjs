// Node ESM resolve hook: src/ uses bundler-style './x.js' specifiers that
// actually live as './x.ts' (wrangler/tsc resolve them; raw node doesn't).
export async function resolve(specifier, context, next) {
  try {
    return await next(specifier, context);
  } catch (e) {
    if (specifier.startsWith('./') && specifier.endsWith('.js') && context.parentURL) {
      return next(specifier.slice(0, -3) + '.ts', context);
    }
    throw e;
  }
}
