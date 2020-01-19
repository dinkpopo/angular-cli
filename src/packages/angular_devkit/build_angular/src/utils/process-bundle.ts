/**
 * @license
 * Copyright Google Inc. All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.io/license
 */
import {
  NodePath,
  ParseResult,
  PluginObj,
  parseSync,
  transformAsync,
  traverse,
  types,
} from '@babel/core';
import { createHash } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { RawSourceMap } from 'source-map';
import { minify } from 'terser';
import * as v8 from 'v8';
import { SourceMapSource } from 'webpack-sources';
import { manglingDisabled } from './environment-options';
import { I18nOptions } from './i18n-options';

const cacache = require('cacache');
const deserialize = ((v8 as unknown) as { deserialize(buffer: Buffer): unknown }).deserialize;

export interface ProcessBundleOptions {
  filename: string;
  code: string;
  map?: string;
  name: string;
  sourceMaps?: boolean;
  hiddenSourceMaps?: boolean;
  vendorSourceMaps?: boolean;
  runtime?: boolean;
  optimize?: boolean;
  optimizeOnly?: boolean;
  ignoreOriginal?: boolean;
  cacheKeys?: (string | undefined)[];
  integrityAlgorithm?: 'sha256' | 'sha384' | 'sha512';
  runtimeData?: ProcessBundleResult[];
  replacements?: [string, string][];
}

export interface ProcessBundleResult {
  name: string;
  integrity?: string;
  original?: ProcessBundleFile;
  downlevel?: ProcessBundleFile;
}

export interface ProcessBundleFile {
  filename: string;
  size: number;
  integrity?: string;
  map?: {
    filename: string;
    size: number;
  };
}

export const enum CacheKey {
  OriginalCode = 0,
  OriginalMap = 1,
  DownlevelCode = 2,
  DownlevelMap = 3,
}

let cachePath: string | undefined;
let i18n: I18nOptions | undefined;

export function setup(data: number[] | { cachePath: string; i18n: I18nOptions }): void {
  const options = Array.isArray(data)
    ? (deserialize(Buffer.from(data)) as { cachePath: string; i18n: I18nOptions })
    : data;
  cachePath = options.cachePath;
  i18n = options.i18n;
}

async function cachePut(content: string, key: string | undefined, integrity?: string): Promise<void> {
  if (cachePath && key) {
    await cacache.put(cachePath, key || null, content, {
      metadata: { integrity },
    });
  }
}

export async function process(options: ProcessBundleOptions): Promise<ProcessBundleResult> {
  if (!options.cacheKeys) {
    options.cacheKeys = [];
  }

  const result: ProcessBundleResult = { name: options.name };
  if (options.integrityAlgorithm) {
    // Store unmodified code integrity value -- used for SRI value replacement
    result.integrity = generateIntegrityValue(options.integrityAlgorithm, options.code);
  }

  // Runtime chunk requires specialized handling
  if (options.runtime) {
    return { ...result, ...(await processRuntime(options)) };
  }

  const basePath = path.dirname(options.filename);
  const filename = path.basename(options.filename);
  const downlevelFilename = filename.replace(/\-es20\d{2}/, '-es5');
  const downlevel = !options.optimizeOnly;
  const sourceCode = options.code;
  const sourceMap = options.map ? JSON.parse(options.map) : undefined;

  let downlevelCode;
  let downlevelMap;
  if (downlevel) {
    // Downlevel the bundle
    const transformResult = await transformAsync(sourceCode, {
      filename,
      // using false ensures that babel will NOT search and process sourcemap comments (large memory usage)
      // The types do not include the false option even though it is valid
      // tslint:disable-next-line: no-any
      inputSourceMap: false as any,
      babelrc: false,
      presets: [[
        require.resolve('@babel/preset-env'),
        {
          // modules aren't needed since the bundles use webpack's custom module loading
          modules: false,
          // 'transform-typeof-symbol' generates slower code
          exclude: ['transform-typeof-symbol'],
        },
      ]],
      plugins: options.replacements ? [createReplacePlugin(options.replacements)] : [],
      minified: options.optimize,
      // `false` ensures it is disabled and prevents large file warnings
      compact: options.optimize || false,
      sourceMaps: !!sourceMap,
    });

    if (!transformResult || !transformResult.code) {
      throw new Error(`Unknown error occurred processing bundle for "${options.filename}".`);
    }
    downlevelCode = transformResult.code;

    if (sourceMap && transformResult.map) {
      downlevelMap = mergeSourceMaps(
        sourceCode,
        sourceMap,
        downlevelCode,
        transformResult.map,
        filename,
      );
    }
  }

  if (downlevelCode) {
    result.downlevel = await processBundle({
      ...options,
      code: downlevelCode,
      map: downlevelMap,
      filename: path.join(basePath, downlevelFilename),
      isOriginal: false,
    });
  }

  if (!result.original && !options.ignoreOriginal) {
    result.original = await processBundle({
      ...options,
      isOriginal: true,
    });
  }

  return result;
}

// SourceMapSource produces high-quality sourcemaps
function mergeSourceMaps(
  inputCode: string,
  inputSourceMap: RawSourceMap,
  resultCode: string,
  resultSourceMap: RawSourceMap,
  filename: string,
): RawSourceMap {
  // The last argument is not yet in the typings
  // tslint:disable-next-line: no-any
  return new (SourceMapSource as any)(
    resultCode,
    filename,
    resultSourceMap,
    inputCode,
    inputSourceMap,
    true,
  ).map();
}

async function processBundle(
  options: Omit<ProcessBundleOptions, 'map'> & { isOriginal: boolean; map?: string | RawSourceMap },
): Promise<ProcessBundleFile> {
  const {
    optimize,
    isOriginal,
    code,
    map,
    filename: filepath,
    hiddenSourceMaps,
    cacheKeys = [],
    integrityAlgorithm,
   } = options;

  const rawMap = typeof map === 'string' ? JSON.parse(map) as RawSourceMap : map;
  const filename = path.basename(filepath);

  let result: {
    code: string,
    map: RawSourceMap | undefined,
  };

  if (rawMap) {
    rawMap.file = filename;
  }

  if (optimize) {
    result = terserMangle(code, {
      filename,
      map: rawMap,
      compress: !isOriginal, // We only compress bundles which are downlevelled.
      ecma: isOriginal ? 6 : 5,
    });
  } else {
    result = {
      map: rawMap,
      code,
    };
  }

  let mapContent: string | undefined;
  if (result.map) {
    if (!hiddenSourceMaps) {
      result.code += `\n//# sourceMappingURL=${filename}.map`;
    }

    mapContent = JSON.stringify(result.map);

    await cachePut(
      mapContent,
      cacheKeys[isOriginal ? CacheKey.OriginalMap : CacheKey.DownlevelMap],
    );
    fs.writeFileSync(filepath + '.map', mapContent);
  }

  const fileResult = createFileEntry(
    filepath,
    result.code,
    mapContent,
    integrityAlgorithm,
  );

  await cachePut(
    result.code,
    cacheKeys[isOriginal ? CacheKey.OriginalCode : CacheKey.DownlevelCode],
    fileResult.integrity,
  );
  fs.writeFileSync(filepath, result.code);

  return fileResult;
}

function terserMangle(
  code: string,
  options: { filename?: string; map?: RawSourceMap; compress?: boolean; ecma?: 5 | 6 } = {},
) {
  // Note: Investigate converting the AST instead of re-parsing
  // estree -> terser is already supported; need babel -> estree/terser

  // Mangle downlevel code
  const minifyOutput = minify(options.filename ? { [options.filename]: code } : code, {
    compress: options.compress || false,
    ecma: options.ecma || 5,
    mangle: !manglingDisabled,
    safari10: true,
    output: {
      ascii_only: true,
      webkit: true,
    },
    sourceMap:
      !!options.map &&
      ({
        asObject: true,
        // typings don't include asObject option
        // tslint:disable-next-line: no-any
      } as any),
  });

  if (minifyOutput.error) {
    throw minifyOutput.error;
  }

  // tslint:disable-next-line: no-non-null-assertion
  const outputCode = minifyOutput.code!;

  let outputMap;
  if (options.map && minifyOutput.map) {
    outputMap = mergeSourceMaps(
      code,
      options.map,
      outputCode,
      minifyOutput.map as unknown as RawSourceMap,
      options.filename || '0',
    );
  }

  return { code: outputCode, map: outputMap };
}

function createFileEntry(
  filename: string,
  code: string,
  map: string | undefined,
  integrityAlgorithm?: string,
): ProcessBundleFile {
  return {
    filename: filename,
    size: Buffer.byteLength(code),
    integrity: integrityAlgorithm && generateIntegrityValue(integrityAlgorithm, code),
    map: !map
      ? undefined
      : {
          filename: filename + '.map',
          size: Buffer.byteLength(map),
        },
  };
}

function generateIntegrityValue(hashAlgorithm: string, code: string) {
  return (
    hashAlgorithm +
    '-' +
    createHash(hashAlgorithm)
      .update(code)
      .digest('base64')
  );
}

// The webpack runtime chunk is already ES5.
// However, two variants are still needed due to lazy routing and SRI differences
// NOTE: This should eventually be a babel plugin
async function processRuntime(
  options: ProcessBundleOptions,
): Promise<Partial<ProcessBundleResult>> {
  let originalCode = options.code;
  let downlevelCode = options.code;

  // Replace integrity hashes with updated values
  if (options.integrityAlgorithm && options.runtimeData) {
    for (const data of options.runtimeData) {
      if (!data.integrity) {
        continue;
      }

      if (data.original && data.original.integrity) {
        originalCode = originalCode.replace(data.integrity, data.original.integrity);
      }
      if (data.downlevel && data.downlevel.integrity) {
        downlevelCode = downlevelCode.replace(data.integrity, data.downlevel.integrity);
      }
    }
  }

  // Adjust lazy loaded scripts to point to the proper variant
  // Extra spacing is intentional to align source line positions
  downlevelCode = downlevelCode.replace(/"\-es20\d{2}\./, '   "-es5.');

  return {
    original: await processBundle({
      ...options,
      code: originalCode,
      isOriginal: true,
    }),
    downlevel: await processBundle({
      ...options,
      code: downlevelCode,
      filename: options.filename.replace(/\-es20\d{2}/, '-es5'),
      isOriginal: false,
    }),
  };
}

function createReplacePlugin(replacements: [string, string][]): PluginObj {
  return {
    visitor: {
      StringLiteral(path: NodePath<types.StringLiteral>) {
        for (const replacement of replacements) {
          if (path.node.value === replacement[0]) {
            path.node.value = replacement[1];
          }
        }
      },
    },
  };
}

export interface InlineOptions {
  filename: string;
  code: string;
  map?: string;
  es5: boolean;
  outputPath: string;
  missingTranslation?: 'warning' | 'error' | 'ignore';
  setLocale?: boolean;
}

interface LocalizePosition {
  start: number;
  end: number;
  messageParts: TemplateStringsArray;
  expressions: types.Expression[];
}

const localizeName = '$localize';

export async function inlineLocales(options: InlineOptions) {
  if (!i18n || i18n.inlineLocales.size === 0) {
    return { file: options.filename, diagnostics: [], count: 0 };
  }
  if (i18n.flatOutput && i18n.inlineLocales.size > 1) {
    throw new Error('Flat output is only supported when inlining one locale.');
  }

  const hasLocalizeName = options.code.includes(localizeName);
  if (!hasLocalizeName && !options.setLocale) {
    return inlineCopyOnly(options);
  }

  const { default: MagicString } = await import('magic-string');
  const { default: generate } = await import('@babel/generator');
  const utils = await import(
    // tslint:disable-next-line: trailing-comma no-implicit-dependencies
    '@angular/localize/src/tools/src/translate/source_files/source_file_utils'
  );
  // tslint:disable-next-line: no-implicit-dependencies
  const localizeDiag = await import('@angular/localize/src/tools/src/diagnostics');

  const diagnostics = new localizeDiag.Diagnostics();

  const positions = findLocalizePositions(options, utils);
  if (positions.length === 0 && !options.setLocale) {
    return inlineCopyOnly(options);
  }

  // tslint:disable-next-line: no-any
  let content = new MagicString(options.code, { filename: options.filename } as any);
  const inputMap = options.map && (JSON.parse(options.map) as RawSourceMap);
  let contentClone;
  for (const locale of i18n.inlineLocales) {
    const isSourceLocale = locale === i18n.sourceLocale;
    // tslint:disable-next-line: no-any
    const translations: any = isSourceLocale ? {} : i18n.locales[locale].translation || {};
    for (const position of positions) {
      const translated = utils.translate(
        diagnostics,
        translations,
        position.messageParts,
        position.expressions,
        isSourceLocale ? 'ignore' : options.missingTranslation || 'warning',
      );

      const expression = utils.buildLocalizeReplacement(translated[0], translated[1]);
      const { code } = generate(expression);

      content.overwrite(position.start, position.end, code);
    }

    if (options.setLocale) {
      const setLocaleText = `var $localize=Object.assign(void 0===$localize?{}:$localize,{locale:"${locale}"});`;
      contentClone = content.clone();
      content.prepend(setLocaleText);

      // If locale data is provided, load it and prepend to file
      const localeDataPath = i18n.locales[locale] && i18n.locales[locale].dataPath;
      if (localeDataPath) {
        const localDataContent = loadLocaleData(localeDataPath, true);
        // The semicolon ensures that there is no syntax error between statements
        content.prepend(localDataContent + ';');
      }
    }

    const output = content.toString();
    const outputPath = path.join(
      options.outputPath,
      i18n.flatOutput ? '' : locale,
      options.filename,
    );
    fs.writeFileSync(outputPath, output);

    if (inputMap) {
      const contentMap = content.generateMap();
      const outputMap = mergeSourceMaps(
        options.code,
        inputMap,
        output,
        contentMap,
        options.filename,
      );

      fs.writeFileSync(outputPath + '.map', JSON.stringify(outputMap));
    }

    if (contentClone) {
      content = contentClone;
      contentClone = undefined;
    }
  }

  return { file: options.filename, diagnostics: diagnostics.messages, count: positions.length };
}

function inlineCopyOnly(options: InlineOptions) {
  if (!i18n) {
    throw new Error('i18n options are missing');
  }

  for (const locale of i18n.inlineLocales) {
    const outputPath = path.join(
      options.outputPath,
      i18n.flatOutput ? '' : locale,
      options.filename,
    );
    fs.writeFileSync(outputPath, options.code);
    if (options.map) {
      fs.writeFileSync(outputPath + '.map', options.map);
    }
  }

  return { file: options.filename, diagnostics: [], count: 0 };
}

function findLocalizePositions(
  options: InlineOptions,
  // tslint:disable-next-line: no-implicit-dependencies
  utils: typeof import('@angular/localize/src/tools/src/translate/source_files/source_file_utils'),
): LocalizePosition[] {
  let ast: ParseResult | undefined | null;

  try {
    ast = parseSync(options.code, {
      babelrc: false,
      sourceType: 'script',
    });
  } catch (error) {
    if (error.message) {
      // Make the error more readable.
      // Same errors will contain the full content of the file as the error message
      // Which makes it hard to find the actual error message.
      const index = error.message.indexOf(')\n');
      const msg = index !== -1 ? error.message.substr(0, index + 1) : error.message;
      throw new Error(`${msg}\nAn error occurred inlining file "${options.filename}"`);
    }
  }

  if (!ast) {
    throw new Error(`Unknown error occurred inlining file "${options.filename}"`);
  }

  const positions: LocalizePosition[] = [];
  if (options.es5) {
    traverse(ast, {
      CallExpression(path: NodePath<types.CallExpression>) {
        const callee = path.get('callee');
        if (
          callee.isIdentifier() &&
          callee.node.name === localizeName &&
          utils.isGlobalIdentifier(callee)
        ) {
          const messageParts = utils.unwrapMessagePartsFromLocalizeCall(path);
          const expressions = utils.unwrapSubstitutionsFromLocalizeCall(path.node);
          positions.push({
            // tslint:disable-next-line: no-non-null-assertion
            start: path.node.start!,
            // tslint:disable-next-line: no-non-null-assertion
            end: path.node.end!,
            messageParts,
            expressions,
          });
        }
      },
    });
  } else {
    const traverseFast = ((types as unknown) as {
      traverseFast: (node: types.Node, enter: (node: types.Node) => void) => void;
    }).traverseFast;

    traverseFast(ast, node => {
      if (
        node.type === 'TaggedTemplateExpression' &&
        types.isIdentifier(node.tag) &&
        node.tag.name === localizeName
      ) {
        const messageParts = utils.unwrapMessagePartsFromTemplateLiteral(node.quasi.quasis);
        positions.push({
          // tslint:disable-next-line: no-non-null-assertion
          start: node.start!,
          // tslint:disable-next-line: no-non-null-assertion
          end: node.end!,
          messageParts,
          expressions: node.quasi.expressions,
        });
      }
    });
  }

  return positions;
}

function loadLocaleData(path: string, optimize: boolean): string {
  // The path is validated during option processing before the build starts
  const content = fs.readFileSync(path, 'utf8');

  // NOTE: This can be removed once the locale data files are preprocessed in the framework
  if (optimize) {
    const result = terserMangle(content, {
      compress: true,
      ecma: 5,
    });

    return result.code;
  }

  return content;
}
