//
// Copyright (c) Microsoft.
// Licensed under the MIT license. See LICENSE file in the project root for full license information.
//

/* eslint no-console: ["error", { allow: ["log"] }] */

'use strict';

// To skip this WebJob, setting WEBJOB_REPOS_REPORTS_SKIP should be set to '1'
if (process.env.WEBJOB_REPOS_REPORTS_SKIP == '1' /* loose */) {
  console.log('Reports job is configured to skip execution.');
  process.exit(0);
}

// Kill bit if this takes more than 90 minutes
setTimeout(() => {
  console.log('Kill bit at 90m');
  process.exit(0);
}, 1000 * 60 * 90);

import moment from 'moment';

const started = moment().utc();
const startedString = started.format();

const painlessConfigResolver = require('painless-config-resolver')();

painlessConfigResolver.resolve((configurationError, config) => {
  if (configurationError) {
    throw configurationError;
  }

  if (config && config.github && config.github.jobs && config.github.jobs.reports && config.github.jobs.reports.enabled === true) {
    require('./task')(started, startedString, config);
  } else {
    console.log('Reports job is configured to skip execution.');
    process.exit(0);
  }
});
