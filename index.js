"use strict";

const Promise = require('bluebird');
const _ = require('lodash');
const Cursor = require('pg-cursor');

module.exports = function(pg, app) {

  function override(object, methodName, callback) {
    object[methodName] = callback(object[methodName])
  }

  const url = require('url');

  const connParams = url.parse(app.config.pg.business.pg_conn_string);
  const auth = connParams.auth.split(':');

  const config = {
    user: auth[0],
    password: auth[1],
    host: connParams.hostname,
    port: connParams.port,
    database: app.config.pg.business.pg_conn_string.split('/')[3]
  };

  const pool = app.pgPool = new pg.Pool(config);

  pool.on('error', function(error) {
    console.log('pg error', error);
  })

  pg.on('error', function(error) {
    console.log('pg error', error);
  })

  // attaching method to pg.Client so all the APIs that use app.pgClient.queryAsync will use connection pooling
  pg.Client.prototype.queryAsync = Promise.promisify(function(query, bindVars, queryCB) {

    var client = this;

    // if no bind vars
    if (queryCB == undefined) {
      queryCB = bindVars;
      bindVars = [];
    }

    if (this.inTransaction) {
     client.query(query, bindVars, queryCB);
    } else {  
      pool.connect(function(connectErr, pgClient, connectFinishFn) {
        pgClient.query(query, bindVars, function(err, queryRes) {
          connectFinishFn();
          queryCB(err, queryRes);
        });
      });
    }   
  });

  // grab client from pool, then create begin transaction
  pg.Client.prototype.transactionStart = Promise.promisify(function(cb) {
    pool.connect(function(connectErr, pgClient, connectFinishFn) {
      pgClient.returnClientToPool = connectFinishFn;
      pgClient.inTransaction = true;
      pgClient.query('BEGIN', function(err, beginResult) {
        cb(connectErr, pgClient);
      });
    });
  });
 
  // commit + return client to connection pool
  pg.Client.prototype.commit = Promise.promisify(function(cb) {
    var client = this;
    client.inTransaction = false;
    client.query('COMMIT', function(err, commitResult) {
      client.returnClientToPool();
      cb(err, commitResult); 
    });
  });

  // rollback + return client to connection pool
  pg.Client.prototype.rollback = Promise.promisify(function(cb) {
    var client = this;
    client.inTransaction = false;
    client.query('ROLLBACK', function(err, rollbackResult) {
      client.returnClientToPool();
      cb(err, rollbackResult); 
    });
  });

  const convertHandlebarsTemplateToQuery = function(obj, substVals) {
    /* lodash template handling
     *   since template strings do not allow templates-within-templates
     *   and a shortcut way to just inject blocks of sql that is trusted (i.e. not input from ajax call)
     */
    if (substVals) {
      var numSubstTries = 0;
      while (numSubstTries < 5 && obj.query.match(/{{/)) {
        _.templateSettings.interpolate = /{{([\s\S]+?)}}/g;
        var compiled = _.template(obj.query);
        obj.query = compiled(substVals);
        numSubstTries++;
      }
    }  
  }

  pg.Client.prototype.queryTmpl = function(obj, substVals) {
  
    convertHandlebarsTemplateToQuery(obj, substVals);

    var me = this;
    var queryWrapper = new Promise(function(resolve, reject) {
      pg.Client.prototype.queryAsync.call(me, obj.query, obj.values)
        .then(function(queryResult) {
          queryResult = _.pick(queryResult, ['rowCount', 'rows']);
          resolve(queryResult);
        })
        .catch(function(e) {
          console.log('query error in promise', e)
          reject(e);
        });
    });

    return queryWrapper;
  };

  const cursorQuery = function(query, bindVars, cursorCB) {
 
    pool.connect(function(connectErr, pgClient, connectFinishFn) {
      let cursor = pgClient.query(new Cursor(query, bindVars));
      cursor.endConnection = connectFinishFn;

      cursor.readAsync = Promise.promisify(function(numRows, readWrapperCB) {
        
        cursor.read(numRows, function(err, rows) {
          if (err) {
            connectFinishFn(err);
            return readWrapperCB(err);
          }
 
          if (!rows.length) {
            connectFinishFn();
            return readWrapperCB(null, rows);
          }

          readWrapperCB(null, rows); 
        });
      }); 
     
      cursorCB(connectErr, cursor);
    });

  };

  pg.Client.prototype.cursorAsync = Promise.promisify(cursorQuery);

  pg.Client.prototype.cursorTmpl = Promise.promisify(function(obj, substVals, cursorCB) {

    // if no bind vars
    if (cursorCB == undefined) {
      cursorCB = substVals;
      substVals = [];
    }

    convertHandlebarsTemplateToQuery(obj, substVals);

    cursorQuery(obj.query, obj.values, cursorCB);
  });

  exports.sqlTemplate = pg.Client.prototype.sqlTmpl = function(pieces) {
    var result = '';
    var vals = [];
    var substitutions = [].slice.call(arguments, 1);
    for (var i = 0; i < substitutions.length; ++i) {
      result += pieces[i] + '$' + (i + 1);
      vals.push(substitutions[i]);
    }

    result += pieces[substitutions.length];

    return {query: result, values: vals};
  };

  return exports;
}

