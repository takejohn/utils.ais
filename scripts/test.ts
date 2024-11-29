import * as fs from 'fs/promises';
import chalk from 'chalk';
import { Parser, Interpreter, errors, Ast, values, utils } from '@syuilo/aiscript';
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

class Context {
	private currentExecuting = 'root';

	private readonly interpreter = new Interpreter({}, {
		in: () => Promise.reject(new Error('Cannot use standard input during test')),
		err: (e) => this.catch(this.currentExecuting, e),
	});

	private readonly errors: TestError[] = [];

	private acceptError = false;

	private acceptedError: AiScriptError | undefined;

	public parse(filename: string, script: string): Ast.Node[] | undefined {
		try {
			return Parser.parse(script);
		} catch (e) {
			this.catch(`parsing ${filename}`, e);
		}
	}

	public async runScript(filename: string, script: string): Promise<void> {
		const ast = this.parse(filename, script);
		if (ast != null) {
			await this.run(filename, ast);
		}
	}

	public async run(filename: string, ast: Ast.Node[]): Promise<void> {
		await this.execute(`executing \`${filename}\``, () => this.interpreter.exec(ast));
	}

	public async runTestFunctions() {
		for (const [name, { value }] of this.interpreter.scope.getAll().entries()) {
			if (value.attr == null) {
				continue;
			}
			for (const attr of value.attr) {
				if (attr.name != 'test') {
					this.addError({ message: `Unknown attribute for variable \`${name}\`: \`${attr.name}\`` });
					continue;
				}
				if (value.type != 'fn') {
					this.addError({ message: `\`${name}\` is ${value.type}, but has 'test' attribute`});
					continue;
				}
				await this.runTestFunction(name, attr.value, value);
			}
		}
	}

	private async runTestFunction(name: string, attr: values.Value, fn: values.VFn) {
		const checkedAttr = this.checkTestAttribute(name, attr);
		if (checkedAttr == null) {
			return;
		}

		if (checkedAttr.err) {
			this.acceptError = true;
			await this.executeFunction(name, fn);
			this.acceptError = false;
			if (this.acceptedError == null) {
				this.addError({ message: `Expected error `})
			} else {
				this.acceptedError = undefined;
			}
		} else {
			await this.executeFunction(name, fn);
		}
	}

	private checkTestAttribute(fnName: string, attr: values.Value): { err?: boolean } | undefined {
		if (attr.type == 'bool' && attr.value) {
			return {};
		} else if (attr.type == 'str') {
			if (attr.value == 'err') {
				return { err: true };
			}
			this.addError({ message: `Unexpected test attribute: ${attr.value}, function: \`${fnName}\``});
		} else {
			this.addError({ message: `Unexpected test attribute value: ${utils.reprValue(attr, true)}, function: \`${fnName}\`` });
		}
	}

	private async executeFunction(name: string, fn: values.VFn): Promise<void> {
		await this.execute(`function \`${name}\``, () => this.interpreter.execFn(fn, []).then(() => {}));
	}

	private async execute(currentExecuting: string, executor: () => Promise<void>) {
		try {
			this.currentExecuting = currentExecuting;
			await executor();
			this.currentExecuting = 'root';
		} catch (e) {
			this.catch(currentExecuting, e);
		}
	}

	private addError(error: TestError): void {
		this.errors.push(error);
	}

	private catch(message: string, e: unknown): void {
		if (e instanceof AiScriptError) {
			if (!this.acceptError) {
				this.addError({
					message,
					cause: e,
				});
			} else {
				this.acceptedError = e;
			}
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

async function runTest(filename: string): Promise<TestResult> {
	const context = new Context();

	const dirname = path.dirname(filename);
	const script = await fs.readFile(filename, 'utf8');
	const ast = context.parse(filename, script);
	if (ast == null) {
		return context.toResult();
	}

	const imports: unknown = Interpreter.collectMetadata(ast)?.get('imports');
	if (!(imports instanceof Array && imports.every((filename) => typeof filename == 'string'))) {
		throw new errors.AiScriptTypeError('Unexpected type of imports');
	}

	const importScripts = await Promise.all(imports.map(async (filename) => {
		const script = await fs.readFile(path.resolve(dirname, filename), 'utf8');
		return [filename, script];
	}));
	for (const [filename, script] of importScripts) {
		await context.runScript(filename, script);
	}

	await context.run(filename, ast);
	await context.runTestFunctions();

	return context.toResult();
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
