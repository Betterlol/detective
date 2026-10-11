import { parseCliArguments } from './cli-args.js';
import { runCliCommand } from './cli-commands.js';

const args = parseCliArguments(process.argv.slice(2));
runCliCommand(args.command, args).catch(e => { console.error(String(e)); process.exitCode = 1; });
