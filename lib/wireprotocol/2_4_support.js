"use strict";

var Insert = require('./commands').Insert
  , Update = require('./commands').Update
  , Remove = require('./commands').Remove
  , Query = require('../connection/commands').Query
  , copy = require('../connection/utils').copy
  , KillCursor = require('../connection/commands').KillCursor
  , GetMore = require('../connection/commands').GetMore
  , Query = require('../connection/commands').Query
  , ReadPreference = require('../topologies/read_preference')
  , f = require('util').format
  , CommandResult = require('../topologies/command_result')
  , MongoError = require('../error')
  , Long = require('bson').Long;

// Write concern fields
var writeConcernFields = ['w', 'wtimeout', 'j', 'fsync'];

var WireProtocol = function() {}

//
// Needs to support legacy mass insert as well as ordered/unordered legacy
// emulation
//
WireProtocol.prototype.insert = function(topology, ismaster, ns, bson, pool, callbacks, ops, options, callback) {
  options = options || {};
  // Default is ordered execution
  var ordered = typeof options.ordered == 'boolean' ? options.ordered : true;
  var legacy = typeof options.legacy == 'boolean' ? options.legacy : false;
  ops = Array.isArray(ops) ? ops :[ops];

  // If we have more than a 1000 ops fails
  if(ops.length > 1000) return callback(new MongoError("exceeded maximum write batch size of 1000"));

  // Write concern
  var writeConcern = options.writeConcern || {w:1};

  // We are unordered
  if(!ordered || writeConcern.w == 0) {
    return executeUnordered('insert', Insert, ismaster, ns, bson, pool, callbacks, ops, options, callback);
  }

  return executeOrdered('insert', Insert, ismaster, ns, bson, pool, callbacks, ops, options, callback);
}

WireProtocol.prototype.update = function(topology, ismaster, ns, bson, pool, callbacks, ops, options, callback) {
  options = options || {};
  // Default is ordered execution
  var ordered = typeof options.ordered == 'boolean' ? options.ordered : true;
  ops = Array.isArray(ops) ? ops :[ops];

  // Write concern
  var writeConcern = options.writeConcern || {w:1};

  // We are unordered
  if(!ordered || writeConcern.w == 0) {
    return executeUnordered('update', Update, ismaster, ns, bson, pool, callbacks, ops, options, callback);
  }

  return executeOrdered('update', Update, ismaster, ns, bson, pool, callbacks, ops, options, callback);
}

WireProtocol.prototype.remove = function(topology, ismaster, ns, bson, pool, callbacks, ops, options, callback) {
  options = options || {};
  // Default is ordered execution
  var ordered = typeof options.ordered == 'boolean' ? options.ordered : true;
  ops = Array.isArray(ops) ? ops :[ops];

  // Write concern
  var writeConcern = options.writeConcern || {w:1};

  // We are unordered
  if(!ordered || writeConcern.w == 0) {
    return executeUnordered('remove', Remove, ismaster, ns, bson, pool, callbacks, ops, options, callback);
  }

  return executeOrdered('remove', Remove, ismaster, ns, bson, pool, callbacks, ops, options, callback);
}

WireProtocol.prototype.killCursor = function(bson, ns, cursorId, connection, callbacks, callback) {
  // Create a kill cursor command
  var killCursor = new KillCursor(bson, [cursorId]);
  // Execute the kill cursor command
  if(connection && connection.isConnected()) connection.write(killCursor.toBin());
  // Set cursor to 0
  cursorId = Long.ZERO;
  // Return to caller
  if(callback) callback(null, null);
}

WireProtocol.prototype.getMore = function(bson, ns, cursorState, batchSize, raw, connection, callbacks, options, callback) {
  // Create getMore command
  var getMore = new GetMore(bson, ns, cursorState.cursorId, {numberToReturn: batchSize});

  // Query callback
  var queryCallback = function(err, r) {
    if(err) return callback(err);

    // If we have a timed out query or a cursor that was killed
    if((r.responseFlags & (1 << 0)) != 0) {
      return callback(new MongoError("cursor killed or timed out"), null);
    }

    // Ensure we have a Long valie cursor id
    var cursorId = typeof r.cursorId == 'number'
      ? Long.fromNumber(r.cursorId)
      : r.cursorId;

    // Set all the values
    cursorState.documents = r.documents;
    cursorState.cursorId = cursorId;

    // Return
    callback(null);
  }

  // If we have a raw query decorate the function
  if(raw) {
    queryCallback.raw = raw;
  }

  // Register a callback
  callbacks.register(getMore.requestId, queryCallback);
  // Write out the getMore command
  connection.write(getMore.toBin());
}

WireProtocol.prototype.command = function(bson, ns, cmd, cursorState, topology, options) {
  // Establish type of command
  if(cmd.find) {
    return setupClassicFind(bson, ns, cmd, cursorState, topology, options)
  } else if(cursorState.cursorId != null) {
  } else if(cmd) {
    return setupCommand(bson, ns, cmd, cursorState, topology, options);
  } else {
    throw new MongoError(f("command %s does not return a cursor", JSON.stringify(cmd)));
  }
}

//
// Execute a find command
var setupClassicFind = function(bson, ns, cmd, cursorState, topology, options) {
  var readPreference = options.readPreference || new ReadPreference('primary');
  if(typeof readPreference == 'string') readPreference = new ReadPreference(readPreference);
  if(!(readPreference instanceof ReadPreference)) throw new MongoError('readPreference must be a ReadPreference instance');

  // Does the cmd have a readPreference
  if(cmd.readPreference) {
    readPreference = cmd.readPreference;
  }

  // Ensure we have at least some options
  options = options || {};
  // Set the optional batchSize
  cursorState.batchSize = cmd.batchSize || cursorState.batchSize;
  var numberToReturn = 0;

  // Unpack the limit and batchSize values
  if(cursorState.limit == 0) {
    numberToReturn = cursorState.batchSize;
  } else if(cursorState.limit < 0 || cursorState.limit < cursorState.batchSize || (cursorState.limit > 0 && cursorState.batchSize == 0)) {
    numberToReturn = cursorState.limit;
  } else {
    numberToReturn = cursorState.batchSize;
  }

  var numberToSkip = cursorState.skip || 0;
  // Build actual find command
  var findCmd = {};
  // Using special modifier
  var usesSpecialModifier = false;

  // We have a Mongos topology, check if we need to add a readPreference
  if(topology.type == 'mongos' && readPreference) {
    findCmd['$readPreference'] = readPreference.toJSON();
    usesSpecialModifier = true;
  }

  // Add special modifiers to the query
  if(cmd.sort) findCmd['orderby'] = cmd.sort, usesSpecialModifier = true;
  if(cmd.hint) findCmd['$hint'] = cmd.hint, usesSpecialModifier = true;
  if(cmd.snapshot) findCmd['$snapshot'] = cmd.snapshot, usesSpecialModifier = true;
  if(cmd.returnKey) findCmd['$returnKey'] = cmd.returnKey, usesSpecialModifier = true;
  if(cmd.maxScan) findCmd['$maxScan'] = cmd.maxScan, usesSpecialModifier = true;
  if(cmd.min) findCmd['$min'] = cmd.min, usesSpecialModifier = true;
  if(cmd.max) findCmd['$max'] = cmd.max, usesSpecialModifier = true;
  if(cmd.showDiskLoc) findCmd['$showDiskLoc'] = cmd.showDiskLoc, usesSpecialModifier = true;
  if(cmd.comment) findCmd['$comment'] = cmd.comment, usesSpecialModifier = true;
  if(cmd.maxTimeMS) findCmd['$maxTimeMS'] = cmd.maxTimeMS, usesSpecialModifier = true;

  if(cmd.explain) {
	// nToReturn must be 0 (match all) or negative (match N and close cursor)
	// nToReturn > 0 will give explain results equivalent to limit(0)
    numberToReturn = -Math.abs(cmd.limit || 0);
    usesSpecialModifier = true;
    findCmd['$explain'] = true;
  }

  // If we have a special modifier
  if(usesSpecialModifier) {
    findCmd['$query'] = cmd.query;
  } else {
    findCmd = cmd.query;
  }

  // Throw on majority readConcern passed in
  if(cmd.readConcern && cmd.readConcern.level != 'local') {
    throw new MongoError(f('server find command does not support a readConcern level of %s', cmd.readConcern.level));
  }

  // Remove readConcern, ensure no failing commands
  if(cmd.readConcern) {
    cmd = copy(cmd);
    delete cmd['readConcern'];
  }

  // Set up the serialize and ignoreUndefined fields
  var serializeFunctions = typeof options.serializeFunctions == 'boolean'
    ? options.serializeFunctions : false;
  var ignoreUndefined = typeof options.ignoreUndefined == 'boolean'
    ? options.ignoreUndefined : false;

  // Build Query object
  var query = new Query(bson, ns, findCmd, {
      numberToSkip: numberToSkip, numberToReturn: numberToReturn
    , checkKeys: false, returnFieldSelector: cmd.fields
    , serializeFunctions: serializeFunctions, ignoreUndefined: ignoreUndefined
  });

  // Set query flags
  query.slaveOk = readPreference.slaveOk();

  // Set up the option bits for wire protocol
  if(typeof cmd.tailable == 'boolean') query.tailable = cmd.tailable;
  if(typeof cmd.oplogReplay == 'boolean') query.oplogReplay = cmd.oplogReplay;
  if(typeof cmd.noCursorTimeout == 'boolean') query.noCursorTimeout = cmd.noCursorTimeout;
  if(typeof cmd.awaitData == 'boolean') query.awaitData = cmd.awaitData;
  if(typeof cmd.exhaust == 'boolean') query.exhaust = cmd.exhaust;
  if(typeof cmd.partial == 'boolean') query.partial = cmd.partial;
  // Return the query
  return query;
}

//
// Set up a command cursor
var setupCommand = function(bson, ns, cmd, cursorState, topology, options) {
  var readPreference = options.readPreference || new ReadPreference('primary');
  if(typeof readPreference == 'string') readPreference = new ReadPreference(readPreference);
  if(!(readPreference instanceof ReadPreference)) throw new MongoError('readPreference must be a ReadPreference instance');

  // Does the cmd have a readPreference
  if(cmd.readPreference) {
    readPreference = cmd.readPreference;
  }

  // Set empty options object
  options = options || {}

  // Final query
  var finalCmd = {};
  for(var name in cmd) {
    finalCmd[name] = cmd[name];
  }

  // Build command namespace
  var parts = ns.split(/\./);

  // Throw on majority readConcern passed in
  if(cmd.readConcern && cmd.readConcern.level != 'local') {
    throw new MongoError(f('server %s command does not support a readConcern level of %s', JSON.stringify(cmd), cmd.readConcern.level));
  }

  // Remove readConcern, ensure no failing commands
  if(cmd.readConcern) delete cmd['readConcern'];

  // Serialize functions
  var serializeFunctions = typeof options.serializeFunctions == 'boolean'
    ? options.serializeFunctions : false;

  // Set up the serialize and ignoreUndefined fields
  var ignoreUndefined = typeof options.ignoreUndefined == 'boolean'
    ? options.ignoreUndefined : false;

  // We have a Mongos topology, check if we need to add a readPreference
  if(topology.type == 'mongos'
    && readPreference
    && readPreference.preference != 'primary') {
    finalCmd = {
      '$query': finalCmd,
      '$readPreference': readPreference.toJSON()
    };
  }

  // Build Query object
  var query = new Query(bson, f('%s.$cmd', parts.shift()), finalCmd, {
      numberToSkip: 0, numberToReturn: -1
    , checkKeys: false, serializeFunctions: serializeFunctions
    , ignoreUndefined: ignoreUndefined
  });

  // Set query flags
  query.slaveOk = readPreference.slaveOk();

  // Return the query
  return query;
}

/**
 * @ignore
 */
var bindToCurrentDomain = function(callback) {
  var domain = process.domain;
  if(domain == null || callback == null) {
    return callback;
  } else {
    return domain.bind(callback);
  }
}

var hasWriteConcern = function(writeConcern) {
  if(writeConcern.w
    || writeConcern.wtimeout
    || writeConcern.j == true
    || writeConcern.fsync == true
    || Object.keys(writeConcern).length == 0) {
    return true;
  }
  return false;
}

var cloneWriteConcern = function(writeConcern) {
  var wc = {};
  if(writeConcern.w != null) wc.w = writeConcern.w;
  if(writeConcern.wtimeout != null) wc.wtimeout = writeConcern.wtimeout;
  if(writeConcern.j != null) wc.j = writeConcern.j;
  if(writeConcern.fsync != null) wc.fsync = writeConcern.fsync;
  return wc;
}

//
// Aggregate up all the results
//
var aggregateWriteOperationResults = function(opType, ops, results, connection) {
  var finalResult = { ok: 1, n: 0 }

  // Map all the results coming back
  for(var i = 0; i < results.length; i++) {
    var result = results[i];
    var op = ops[i];

    if((result.upserted || (result.updatedExisting == false)) && finalResult.upserted == null) {
      finalResult.upserted = [];
    }

    // Push the upserted document to the list of upserted values
    if(result.upserted) {
      finalResult.upserted.push({index: i, _id: result.upserted});
    }

    // We have an upsert where we passed in a _id
    if(result.updatedExisting == false && result.n == 1 && result.upserted == null) {
      finalResult.upserted.push({index: i, _id: op.q._id});
    }

    // We have an insert command
    if(result.ok == 1 && opType == 'insert' && result.err == null) {
      finalResult.n = finalResult.n + 1;
    }

    // We have a command error
    if(result != null && result.ok == 0 || result.err || result.errmsg) {
      if(result.ok == 0) finalResult.ok = 0;
      finalResult.code = result.code;
      finalResult.errmsg = result.errmsg || result.err || result.errMsg;

      // Check if we have a write error
      if(result.code == 11000
        || result.code == 11001
        || result.code == 12582
        || result.code == 16544
        || result.code == 16538
        || result.code == 16542
        || result.code == 14
        || result.code == 13511) {
        if(finalResult.writeErrors == null) finalResult.writeErrors = [];
        finalResult.writeErrors.push({
            index: i
          , code: result.code
          , errmsg: result.errmsg || result.err || result.errMsg
        });
      } else {
        finalResult.writeConcernError = {
            code: result.code
          , errmsg: result.errmsg || result.err || result.errMsg
        }
      }
    } else if(typeof result.n == 'number') {
      finalResult.n += result.n;
    } else {
      finalResult.n += 1;
    }

    // Result as expected
    if(result != null && result.lastOp) finalResult.lastOp = result.lastOp;
  }

  // Return finalResult aggregated results
  return new CommandResult(finalResult, connection);
}

//
// Execute all inserts in an ordered manner
//
var executeOrdered = function(opType ,command, ismaster, ns, bson, pool, callbacks, ops, options, callback) {
  var _ops = ops.slice(0);
  // Bind to current domain
  callback = bindToCurrentDomain(callback);
  // Collect all the getLastErrors
  var getLastErrors = [];

  // Execute an operation
  var executeOp = function(list, _callback) {
    // Get a pool connection
    var connection = pool.get();
    // No more items in the list
    if(list.length == 0) {
      return process.nextTick(function() {
        _callback(null, aggregateWriteOperationResults(opType, ops, getLastErrors, connection));
      });
    }

    // Get the first operation
    var doc = list.shift();

    // Create an insert command
    var op = new command(Query.getRequestId(), ismaster, bson, ns, [doc], options);
    // Write concern
    var optionWriteConcern = options.writeConcern || {w:1};
    // Final write concern
    var writeConcern = cloneWriteConcern(optionWriteConcern);

    // Get the db name
    var db = ns.split('.').shift();

    // Error out if no connection available
    if(connection == null)
      return _callback(new MongoError("no connection available"));

    try {
      // Execute the insert
      connection.write(op.toBin());

      // If write concern 0 don't fire getLastError
      if(hasWriteConcern(writeConcern)) {
        var getLastErrorCmd = {getlasterror: 1};
        // Merge all the fields
        for(var i = 0; i < writeConcernFields.length; i++) {
          if(writeConcern[writeConcernFields[i]] != null)
            getLastErrorCmd[writeConcernFields[i]] = writeConcern[writeConcernFields[i]];
        }

        // Create a getLastError command
        var getLastErrorOp = new Query(bson, f("%s.$cmd", db), getLastErrorCmd, {numberToReturn: -1});
        // Write the lastError message
        connection.write(getLastErrorOp.toBin());
        // Register the callback
        callbacks.register(getLastErrorOp.requestId, function(err, result) {
          if(err) return callback(err);
          // Get the document
          var doc = result.documents[0];
          // Save the getLastError document
          getLastErrors.push(doc);
          // If we have an error terminate
          if(doc.ok == 0 || doc.err || doc.errmsg) return callback(null, aggregateWriteOperationResults(opType, ops, getLastErrors, connection));
          // Execute the next op in the list
          executeOp(list, callback);
        });
      }
    } catch(err) {
      if(typeof err == 'string') err = new MongoError(err);
      // We have a serialization error, rewrite as a write error to have same behavior as modern
      // write commands
      getLastErrors.push({ ok: 1, errmsg: err.message, code: 14 });
      // Return due to an error
      process.nextTick(function() {
        callback(null, aggregateWriteOperationResults(opType, ops, getLastErrors, connection));
      });
    }
  }

  // Execute the operations
  executeOp(_ops, callback);
}

var executeUnordered = function(opType, command, ismaster, ns, bson, pool, callbacks, ops, options, callback) {
  // Bind to current domain
  callback = bindToCurrentDomain(callback);
  // Total operations to write
  var totalOps = ops.length;
  // Collect all the getLastErrors
  var getLastErrors = [];
  // Write concern
  var optionWriteConcern = options.writeConcern || {w:1};
  // Final write concern
  var writeConcern = cloneWriteConcern(optionWriteConcern);
  // Driver level error
  var error;

  // Execute all the operations
  for(var i = 0; i < ops.length; i++) {
    // Create an insert command
    var op = new command(Query.getRequestId(), ismaster, bson, ns, [ops[i]], options);
    // Get db name
    var db = ns.split('.').shift();

    // Get a pool connection
    var connection = pool.get();

    // Error out if no connection available
    if(connection == null) {
      return process.nextTick(function() {
        _callback(new MongoError("no connection available"));
      });
    }

    try {
      // Execute the insert
      connection.write(op.toBin());

      // If write concern 0 don't fire getLastError
      if(hasWriteConcern(writeConcern)) {
        var getLastErrorCmd = {getlasterror: 1};
        // Merge all the fields
        for(var j = 0; j < writeConcernFields.length; j++) {
          if(writeConcern[writeConcernFields[j]] != null)
            getLastErrorCmd[writeConcernFields[j]] = writeConcern[writeConcernFields[j]];
        }

        // Create a getLastError command
        var getLastErrorOp = new Query(bson, f("%s.$cmd", db), getLastErrorCmd, {numberToReturn: -1});
        // Write the lastError message
        connection.write(getLastErrorOp.toBin());

        // Give the result from getLastError the right index
        var callbackOp = function(_index) {
          return function(err, result) {
            if(err) error = err;
            // Update the number of operations executed
            totalOps = totalOps - 1;
            // Save the getLastError document
            if(!err) getLastErrors[_index] = result.documents[0];
            // Check if we are done
            if(totalOps == 0) {
              process.nextTick(function() {
                if(error) return callback(error);
                callback(null, aggregateWriteOperationResults(opType, ops, getLastErrors, connection));
              });
            }
          }
        }

        // Register the callback
        callbacks.register(getLastErrorOp.requestId, callbackOp(i));
      }
    } catch(err) {
      if(typeof err == 'string') err = new MongoError(err);
      // Update the number of operations executed
      totalOps = totalOps - 1;
      // We have a serialization error, rewrite as a write error to have same behavior as modern
      // write commands
      getLastErrors[i] = { ok: 1, errmsg: err.message, code: 14 };
      // Check if we are done
      if(totalOps == 0) {
        callback(null, aggregateWriteOperationResults(opType, ops, getLastErrors, connection));
      }
    }
  }

  // Empty w:0 return
  if(writeConcern
    && writeConcern.w == 0 && callback) {
    callback(null, null);
  }
}

module.exports = WireProtocol;
