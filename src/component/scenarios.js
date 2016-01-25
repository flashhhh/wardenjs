import {check, root} from '../util.js';
import assert from 'assert';
import path from 'path';
import fs from 'fs';
import suspend from 'suspend';
import mime from 'mime';
import {fork} from 'child_process';

export function load(filePath) {
  let fullPath;
  if (path.isAbsolute(filePath)) {
    fullPath = path.normalize(filePath);
  } else {
    fullPath = path.join(process.cwd(), filePath);
  }

  return require(fullPath);
}

export function run(scenario, config) {
  check.function(scenario.fn);
  check.string(scenario.name);
  return new Promise((resolve) => {
    let timeoutId;
    const result = {
      finalMessage: null,
      warning: [],
      info: [],
      status: null,
      files: [],
      name: scenario.name,
      time: null
    };

    let executionStartTime;

    const control = {
      warning(text) {
        return message(text, 'warning');
      },
      info(text) {
        return message(text, 'info');
      },
      success(message = 'Passed') { return finish('success', message); },
      failure(message = 'Failed') { return finish('failure', message); },
      /** input can be either a path or content **/
      file: suspend.promise(function*(name, input, media) {
        if (result.status !== null) throw Error('Scenario is already finished!');
        let fileContent;

        check.string(name);

        if (typeof input === 'string') {
          if (!path.isAbsolute(input)) {
            throw Error('path should be absolute!');
          }
          const fileExists = yield fs.exists(input, suspend.resumeRaw());
          if (!fileExists) {
            throw Error(`File '${input}' doesn't exist!`);
          }

          fileContent = yield fs.readFile(input, suspend.resume());
        } else if (Buffer.prototype.isPrototypeOf(input)) {
          fileContent = input;
        } else {
          throw Error('input should be either string or buffer!');
        }

        check.string(media);
        const fileExtension = mime.extension(media);
        if (!fileExtension) {
          throw Error(`Unknown mime type: ${media}`);
        }

        result.files.push({
          name,
          media,
          content: fileContent
        });

        return true;
      })
    };

    function onError(err) {
      control.failure(
        'Scenario is broken! There was an unexpected error.\n' +
        `Stack: ${err.stack}\n`
      );
    }

    function onErrorHandler(err) {
      clearTimeout(timeoutId);
      onError(err);
    }

    function message(text, type) {
      if (result.status !== null) return false;
      check.string(text);
      result[type].push(text);
      return true;
    }

    function finish(status, finalMessage) {
      if (result.status !== null) return false;
      process.removeListener('uncaughtException', onErrorHandler);

      check.string(status);
      if (typeof finalMessage !== 'string') finalMessage = Error(finalMessage);
      finalMessage = String(finalMessage);
      const statuses = ['success', 'failure'];
      assert(
        statuses.indexOf(status) !== -1,
        `Status can be only one of these values: ${statuses}`
      );

      clearTimeout(timeoutId);
      result.finalMessage = finalMessage;
      result.status = status;
      const timeDiff = process.hrtime(executionStartTime);
      result.time = (timeDiff[0] + timeDiff[1] / 1e9); //s
      resolve(result);
      return true;
    }

    const timeoutSecs = parseInt(scenario.timeout, 10) || 30;
    timeoutId = setTimeout(() => {
      control.failure(`TIMEOUT: ${timeoutSecs} seconds.`);
    }, timeoutSecs * 1000);

    process.on('uncaughtException', onErrorHandler);
    executionStartTime = process.hrtime();
    try {
      scenario.fn(control, config);
    } catch (e) {
      onError(e);
    }
  });
}

export function runForked(scenarioFile, configPath) {
  check.string(scenarioFile);
  return new Promise((resolve, reject) => {
    const child = fork(
      path.join(root, 'index.js'),
      ['run', '--path', scenarioFile, '--config', configPath], {
      silent: global.silentFork !== undefined ? global.silentFork : false
    });
    child.on('error', reject);
    child.on('message', (result) => {
      if (result.type === 'SCENARIO_RESULT') {
        child.kill();
        resolve(result.data);
      }
    });
  });

}

export function runGroup(scenarioFiles, configPath) {
  return Promise.all(scenarioFiles.map((s) => runForked(s, configPath)));
}

export const saveToDb = suspend.promise(function*(db, result, filePath, groupName = null) {
  const transaction = yield db.transaction();
  if (groupName) {
    yield db.models.group.upsert({ name: groupName }, { transaction });
  }
  const resultRow = yield db.models.result.create({
    file_path: filePath,
    name: result.name,
    warning: result.warning,
    info: result.info,
    status: result.status,
    final_message: result.finalMessage,
    group_id: groupName ? (yield db.models.group.findOne({
        where: {
          name: groupName
        },
        transaction
      }
    )).id : null
  }, {transaction});
  if (result.files.length) {
    yield Promise.all(result.files.map((file) => {
      return db.models.file.create(
        Object.assign({result_id: resultRow.id}, file),
        { transaction }
      );
    }));
  }
  transaction.commit();
});