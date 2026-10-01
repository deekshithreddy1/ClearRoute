import ts from 'typescript';

export function compile(configName, emit = false) {
  const file = ts.readConfigFile(configName, ts.sys.readFile);
  if (file.error) throw new Error(ts.flattenDiagnosticMessageText(file.error.messageText, '\n'));
  const config = ts.parseJsonConfigFileContent(file.config, ts.sys, '.');
  const program = ts.createProgram(config.fileNames, { ...config.options, noEmit: !emit });
  const diagnostics = [...config.errors, ...ts.getPreEmitDiagnostics(program)];
  if (diagnostics.length) {
    throw new Error(ts.formatDiagnosticsWithColorAndContext(diagnostics, { getCanonicalFileName: f => f, getCurrentDirectory: () => process.cwd(), getNewLine: () => '\n' }));
  }
  if (emit) {
    const result = program.emit();
    if (result.emitSkipped) throw new Error('TypeScript build did not emit output.');
  }
}
