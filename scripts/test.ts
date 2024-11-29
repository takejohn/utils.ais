import * as fs from 'fs/promises';
import chalk from 'chalk';
import { Parser, Interpreter, errors, Ast } from '@syuilo/aiscript';
import path from 'path';
import { AiScriptError } from '@syuilo/aiscript/error.js';

const TEST_DIRNAME = 'tests';

interface TestResultBase {
	success: boolean;
}

interface TestSuccess extends TestResultBase {
	success: true;
}

interface TestError {
	message: string;
	cause?: AiScriptError;
}

interface TestFailure extends TestResultBase {
	success: false;
	errors: TestError[];
}

type TestResult = TestSuccess | TestFailure;

class ErrorHandler {
	public readonly errors: TestError[] = [];

	public addError(error: TestError): void {
		this.errors.push(error);
	}

	public catch(message: string, e: unknown): void {
		if (e instanceof AiScriptError) {
			this.addError({
				message,
				cause: e,
			});
		} else {
			throw e;
		}
	}

	public toResult(): TestResult {
		if (this.errors.length == 0) {
			return { success: true };
		} else {
			return { success: false, errors: this.errors };
		}
	}
}

function parse(script: string, errorHandler: ErrorHandler): Ast.Node[] | undefined {
	try {
		return Parser.parse(script);
	} catch (e) {
		errorHandler.catch('parser', e);
	}
}

async function runTest(filename: string): Promise<TestResult> {
	const errorHandler = new ErrorHandler();
	let currentExecuting = 'root';

	const interpreter = new Interpreter({}, {
		in() {
			return Promise.reject(new Error('Cannot use standard input during test'));
		},
		err(e) {
			errorHandler.catch(currentExecuting, e);
		},
	});

	const dirname = path.dirname(filename);
	const script = await fs.readFile(filename, 'utf8');
	const ast = parse(script, errorHandler);
	if (ast == null) {
		return errorHandler.toResult();
	}

	const imports: unknown = Interpreter.collectMetadata(ast)?.get('imports');
	if (!(imports instanceof Array && imports.every((filename) => typeof filename == 'string'))) {
		throw new errors.AiScriptTypeError('Unexpected type of imports');
	}

	const importScripts = await Promise.all(imports.map(filename => fs.readFile(path.resolve(dirname, filename), 'utf8')));
	for (const script of importScripts) {
		const ast = Parser.parse(script);
		try {
			await interpreter.exec(ast);
		} catch (e) {
			errorHandler.catch(`import ${filename}`, e);
		}
	}

	try {
		await interpreter.exec(ast);
	} catch (e) {
		errorHandler.catch('root', e);
	}

	for (const [name, { value }] of interpreter.scope.getAll().entries()) {
		if (value.attr == null) {
			continue;
		}
		for (const attr of value.attr) {
			if (attr.name != 'test') {
				errorHandler.addError({ message: `Unknown attribute for variable \`${name}\`: \`${attr.name}\`` });
				continue;
			}
			if (value.type != 'fn') {
				errorHandler.addError({ message: `\`${name}\` is ${value.type}, but has 'test' attribute`});
				continue;
			}
			try {
				currentExecuting = `function \`${name}\``;
				await interpreter.execFn(value, []);
				currentExecuting = 'root';
			} catch (e) {
				errorHandler.catch(currentExecuting, 'e');
			}
		}
	}

	return errorHandler.toResult();
}

async function runTests(dirname: string) {
	const entries = await fs.readdir(dirname, { withFileTypes: true });
	await Promise.all(entries.map(async (entry) => {
		const name = path.join(dirname, entry.name);
		if (entry.isDirectory()) {
			await runTests(name);
		} else if (entry.isFile()) {
			const result = await runTest(name);
			if (result.success) {
				console.log(`${chalk.green('✔')} ${name}`);
			} else {
				console.log(`${chalk.red('✘')} ${name}`);
				for (const error of result.errors) {
					if (error.cause != null) {
						console.log(chalk.red(`  • ${error.message}:\n    ${error.cause}`));
					} else {
						console.log(chalk.red(`  • ${error.message}`))
					}
				}
			}
		}
	}));
}

await runTests(TEST_DIRNAME);
