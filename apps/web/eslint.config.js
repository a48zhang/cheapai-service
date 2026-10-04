import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import reactHooks from 'eslint-plugin-react-hooks';
import tseslint from 'typescript-eslint';

const appRoot = fileURLToPath(new URL('.', import.meta.url));
const sourceRoot = resolve(appRoot, 'src');

const moduleBoundaries = {
  meta: {
    type: 'problem',
    docs: { description: 'keep the React application dependency direction explicit' },
    schema: [],
    messages: {
      boundary: '{{reason}} ({{source}} imports {{target}})',
    },
  },
  create(context) {
    const sourceFile = context.filename;
    const sourceRelative = relative(sourceRoot, sourceFile);
    const sourceSegments = sourceRelative.split(sep);
    const sourceLayer = sourceSegments[0];
    const sourceFeature = sourceLayer === 'features' ? sourceSegments[1] : undefined;

    return {
      ImportDeclaration(node) {
        const specifier = node.source.value;
        if (typeof specifier !== 'string' || (!specifier.startsWith('.') && !isAbsolute(specifier)))
          return;

        const targetFile = resolve(dirname(sourceFile), specifier);
        const targetRelative = relative(sourceRoot, targetFile);
        if (
          targetRelative === '..' ||
          targetRelative.startsWith(`..${sep}`) ||
          isAbsolute(targetRelative)
        ) {
          context.report({
            node,
            messageId: 'boundary',
            data: {
              source: sourceRelative,
              target: specifier,
              reason:
                'React source must depend on workspace packages through their declared package exports',
            },
          });
          return;
        }

        const targetSegments = targetRelative.split(sep);
        const targetLayer = targetSegments[0];
        const targetFeature = targetLayer === 'features' ? targetSegments[1] : undefined;
        const targetEntry = targetSegments[2] ?? '';
        const usesPublicEntry = targetEntry === 'public' || targetEntry.startsWith('public.');

        let reason;
        if (sourceLayer === 'shared' && ['app', 'features', 'pages'].includes(targetLayer)) {
          reason = 'Shared code cannot depend on application, page, or feature modules';
        } else if (['features', 'pages'].includes(sourceLayer) && targetLayer === 'app') {
          reason = 'Feature and page code cannot depend on application composition';
        } else if (
          sourceLayer === 'features' &&
          targetLayer === 'features' &&
          targetFeature !== sourceFeature &&
          !usesPublicEntry
        ) {
          reason = 'Cross-feature imports must use the target feature’s public.ts entry';
        }

        if (reason) {
          context.report({
            node,
            messageId: 'boundary',
            data: { source: sourceRelative, target: specifier, reason },
          });
        }
      },
    };
  },
};

export default tseslint.config(...tseslint.configs.recommended, {
  files: ['src/**/*.{ts,tsx}'],
  plugins: {
    'react-hooks': reactHooks,
    'cheapai-architecture': { rules: { 'module-boundaries': moduleBoundaries } },
  },
  rules: {
    'react-hooks/rules-of-hooks': 'error',
    'react-hooks/exhaustive-deps': 'error',
    'cheapai-architecture/module-boundaries': 'error',
    'no-restricted-imports': [
      'error',
      {
        paths: [
          {
            name: '@sub2api/worker',
            message:
              'Use @cheapai/contracts and @cheapai/api-client instead of importing Worker internals.',
          },
          {
            name: '@sub2api/web',
            message: 'The React app must not import the legacy Vue application.',
          },
        ],
        patterns: [
          {
            group: ['@sub2api/worker/*', '@sub2api/web/*', '@cheapai/web/src/*'],
            message: 'Use the owning package’s declared public exports.',
          },
        ],
      },
    ],
  },
});
