import fs from 'node:fs/promises'
import vm from 'node:vm'
import path from 'node:path'
import { createRequire } from 'node:module'
import ts from 'typescript'

const nodeRequire = createRequire(import.meta.url)

export const loadTsModule = async (absolutePath, stubModules = {}, contextOverrides = {}) => {
  const source = await fs.readFile(absolutePath, 'utf8')
  const transpiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
    },
    fileName: absolutePath,
  })

  const module = { exports: {} }
  const dirname = path.dirname(absolutePath)

  const localRequire = (specifier) => {
    if (Object.prototype.hasOwnProperty.call(stubModules, specifier)) {
      return stubModules[specifier]
    }

    return nodeRequire(specifier)
  }

  const context = {
    module,
    exports: module.exports,
    require: localRequire,
    __filename: absolutePath,
    __dirname: dirname,
    process,
    console,
    Buffer,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    crypto: globalThis.crypto,
    ...contextOverrides,
  }

  vm.runInNewContext(transpiled.outputText, context, { filename: absolutePath })
  return module.exports
}
