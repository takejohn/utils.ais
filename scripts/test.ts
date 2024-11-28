import * as fs from 'fs/promises';
import chalk from 'chalk';
import { Parser, Interpreter, errors, utils, values } from '@syuilo/aiscript';
import path from 'path';
import { AiScriptError } from '@syuilo/aiscript/error.js';
const { valToString } = utils;

const TEST_DIRNAME = 'tests';

interface TestResultBase {
	success: boolean;
}

interface TestSuccess extends TestResultBase {
	success: true;
}

interface TestError {
	message: string;
	cause: AiScriptError;
}

interface TestFailure extends TestResultBase {
	success: false;
	errors: TestError[];
}

type TestResult = TestSuccess | TestFailure;

async function runTest(filename: string): Promise<TestResult> {
	const failureErrors: TestError[] = [];

	const interpreter = new Interpreter({}, {
		in() {
			return Promise.reject(new Error('Cannot use standard input during test'));
		},
		out(value) {
			console.log(chalk.magenta(valToString(value, true)));
		},
		err(e) {
			failureErrors.push({
				message: 'Error occurred while running',
				cause: e,
			});
		},
	});

	const dirname = path.dirname(filename);
	const script = await fs.readFile(filename, 'utf8');

	try {
		const ast = Parser.parse(script);
		const imports: unknown = Interpreter.collectMetadata(ast)?.get('imports');
		if (imports instanceof Array && imports.every((filename) => typeof filename == 'string')) {
			const scripts = await Promise.all(imports.map(filename => fs.readFile(path.resolve(dirname, filename), 'utf8')));
			for (const script of scripts) {
				const ast = Parser.parse(script);
				await interpreter.exec(ast);
			}
		} else {
			throw new errors.AiScriptTypeError('Unexpected type of imports');
		}
		await interpreter.exec(ast);
		if (failureErrors.length == 0) {
			return { success: true };
		} else {
			return { success: false, errors: failureErrors };
		}
	} catch (e) {
		if (e instanceof AiScriptError) {
			return {
				success: false,
				errors: [{
					message: 'Error occurred while running',
					cause: e,
				}],
			};
		} else {
			throw e;
		}
	}
}

async function runTests(dirname: string) {
	const entries = await fs.readdir(dirname, { withFileTypes: true });
	await Promise.allSettled(entries.map(async (entry) => {
		const name = path.join(dirname, entry.name);
		if (entry.isDirectory()) {
			await runTests(name);
		} else if (entry.isFile()) {
			const result = await runTest(name);
			if (result.success) {
				console.log(`* test ${name}: ${chalk.green('success')}`);
			} else {
				console.log(`* test ${name}: ${chalk.magenta('failure')}`);
				for (const error of result.errors) {
					console.log(chalk.magenta('  ' + error.message + ': \n    ' + error.cause.toString()));
				}
			}
		}
	}));
}

await runTests(TEST_DIRNAME);
