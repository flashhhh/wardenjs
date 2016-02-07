import {optionRequired} from '../cli.js';
import {run, load, saveToDb} from '../component/scenarios.js';
import {load as loadConfig} from '../component/config.js';
import suspend from 'suspend';
import 'colors';
import os from 'os';
import fs from 'fs';
import mkdirp from 'mkdirp';
import rimraf from 'rimraf';
import crypto from 'crypto';
import path from 'path';
import mime from 'mime';

export default function (commander) {
  optionRequired('path');
  optionRequired('config');

  const filePath = commander.path;
  suspend.run(function*() {
    const configObj = yield loadConfig(commander.config);
    console.log(`Trying to load the scenario under the ${filePath}`);
    const scenario = load(filePath);
    console.log('Loaded! Trying to start the scenario...');
    if (typeof scenario.fn !== 'function') {
      console.error('Scenario should be a function!');
      process.exit(1);
    }

    function formattedPrint(message) {
      console.log('\n' + `===== ${message} =====`.bold + '\n');
    }

    formattedPrint(`Start: ${scenario.name} (${filePath})`);

    const result = yield run(scenario, configObj);

    const statusColor = result.status === 'success' ? 'green' : 'red';
    console.log(`Status: ${result.status[statusColor]}.`);

    const messageColor = {
      info: 'cyan',
      warning: 'yellow'
    };
    for (let type of ['info', 'warning']) {
      if (result[type].length) {
        console.log(`There was some ${type} messages:`);
        for (let message of result[type]) {
          console.log(`\t${message}`[messageColor[type]]);
        }
      } else {
        console.log(`There weren\'t any ${type} messages`);
      }
    }

    console.log(`Final message: ${result.finalMessage.yellow}.`);

    if (result.files.length) {
      const tmpDir = path.join(
        os.tmpdir(),
        'wardenjs_tmp',
        `${result.name}_${crypto.createHash('md5').update(filePath).digest('hex').substring(0, 6)}`
      );

      yield rimraf(tmpDir, suspend.resume());
      yield mkdirp(tmpDir, suspend.resume());
      for (let [i, file] of result.files.entries()) {
        // name includes left padding
        const filePath = path
          .join(tmpDir, `${('00' + i).slice(-2)}_${file.name}.${mime.extension(file.media)}`);
        yield fs.writeFile(filePath, file.content, suspend.resume());
      }

      console.log(
        `There were ${result.files.length} file(s) attached.`,
        `You can find them at: ${tmpDir.yellow}`
      );
    }

    formattedPrint(`End: ${scenario.name} (${filePath}). Took ${result.time} seconds.`);

    /**
     * If it's a child process, let's send the result to the parent
     * process through IPC
     */
    if (process.send) {
      yield process.send({
        type: 'SCENARIO_RESULT',
        data: result
      }, suspend.resume());
    }

    if (commander.save) {
      const db = yield require('../component/daemon/postgres.js')(configObj.postgres);
      yield saveToDb(db, result, filePath);
      db.close();
    }

    process.exit();
  });
}
