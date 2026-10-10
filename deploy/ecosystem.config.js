'use strict';

// pm2 process for the ordering server. It always runs ~/current (a symlink to
// the active release), so switching releases is a symlink change + reload.

const home = process.env.APP_HOME || '/home/ordering';

module.exports = {
  apps: [{
    name: 'ordering',
    cwd: `${home}/current`,
    script: `${home}/current/src/server.js`,
    node_args: '--disable-warning=ExperimentalWarning',
    env: { NODE_ENV: 'production' },
    // One process: the database is a single SQLite file.
    instances: 1,
    autorestart: true,
    exp_backoff_restart_delay: 200,
    max_memory_restart: '800M',
    // Time for the graceful shutdown (finish requests, flush Supabase, close the DB).
    kill_timeout: 12000,
    time: true,
    out_file: `${home}/shared/logs/out.log`,
    error_file: `${home}/shared/logs/error.log`,
  }],
};
