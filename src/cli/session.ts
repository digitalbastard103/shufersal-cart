import fs from 'node:fs';
import path from 'node:path';

import { loadConfig, loadDotEnv } from '../config.js';
import { CookieJar } from '../shufersal/cookies.js';
import { hasCredentials, login, savedSession, type LoginMethod } from '../shufersal/connect.js';
import { HttpSession } from '../shufersal/http-session.js';
import { probeSignedIn, SessionError } from '../shufersal/transport.js';

const USAGE = `
Usage:
  npm run login                       Log in: stored username/password if set, else a browser window
  npm run login -- --password         Log in with SHUFERSAL_USERNAME / SHUFERSAL_PASSWORD (no browser)
  npm run login -- --browser          Log in through a browser window (needs a desktop)

  npm run session -- status           Is the saved session still signed in?
  npm run session -- export <file>    Copy the saved session to <file> (to move it to a server)
  npm run session -- import <file>    Use a session file exported elsewhere (checked before it is kept)

A session file is a logged-in key to the Shufersal account until it expires.
Move it over an encrypted channel (scp, a secret store) and delete copies you
no longer need.
`.trimStart();

async function main(): Promise<number> {
  loadDotEnv();
  const args = process.argv.slice(2);
  const command = args[0];
  if (!command || command === '-h' || command === '--help') {
    process.stdout.write(USAGE);
    return command ? 0 : 2;
  }
  const config = loadConfig();
  const cookieFile = path.resolve(process.cwd(), config.cookieFile);
  const log = (m: string) => console.log(`  ${m}`);

  try {
    switch (command) {
      case 'login': {
        const method: LoginMethod = args.includes('--browser') ? 'browser' : args.includes('--password') ? 'password' : 'auto';
        if (method === 'auto') console.log(hasCredentials(config) ? 'Using the stored username/password.' : 'No stored credentials - using a browser window.');
        await login(config, log, method);
        console.log('Signed in. Session saved to', path.relative(process.cwd(), cookieFile));
        return 0;
      }
      case 'status': {
        const session = await savedSession(config, log);
        console.log(session ? 'Signed in.' : 'Not signed in - run: npm run login');
        return session ? 0 : 1;
      }
      case 'export': {
        const target = args[1];
        if (!target) return usage('export needs a target file');
        if (!(await savedSession(config, log))) return fail('No working session to export - run: npm run login');
        fs.mkdirSync(path.dirname(path.resolve(target)), { recursive: true });
        fs.copyFileSync(cookieFile, target);
        console.log(`Exported to ${target}. It is a logged-in key to the account - keep it private and delete it once imported.`);
        return 0;
      }
      case 'import': {
        const source = args[1];
        if (!source || !fs.existsSync(source)) return usage(`import needs an existing session file, got ${source ?? '(none)'}`);
        const jar = CookieJar.load(source);
        if (!jar || jar.size === 0) return fail(`${source} is not a session file (or all of its cookies have expired).`);
        if (!(await probeSignedIn(new HttpSession(jar, cookieFile)))) return fail('That session is no longer signed in - log in again on the machine that exported it.');
        jar.save(cookieFile);
        console.log(`Imported and verified. Saved to ${path.relative(process.cwd(), cookieFile)}. You can delete ${source}.`);
        return 0;
      }
      default:
        return usage(`Unknown command: ${command}`);
    }
  } catch (error) {
    if (error instanceof SessionError) return fail(error.message);
    throw error;
  }
}

function usage(message: string): number {
  console.error(message);
  process.stdout.write('\n' + USAGE);
  return 2;
}

function fail(message: string): number {
  console.error(message);
  return 1;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
