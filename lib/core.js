var documentationify = require('./documentationify'),
    isGeneratorFn = require('is-generator-fn'),
    co = require('co'),
    isObservable = require('is-observable'),
    observableToPromise = require('observable-to-promise'),
    matchers = require('./matchers'),
    createError = require('./create-error'),
    u = require('./util'),
    ExpectationNotMetError = require('./ExpectationNotMetError')

function createCore(opts, blockManager) {
  var addSuiteCallback = opts.addSuiteCallback,
      addSkippedSuiteCallback = opts.addSkippedSuiteCallback,
      addTestCallback = opts.addTestCallback

  blockManager.enter( opts.rootSuite )

  function describe(title, fn) {
    if (arguments.length < 2) throw new Error('too few arguments. Correct usage: describe(title, fn)');
    if (typeof fn !== 'function') throw new Error('Wrong argument type. fn must be a function.');
    var suite = addSuiteCallback(blockManager.currentSuite(), title)
    blockManager.enter(suite)
    fn.call(suite) // `this` of describe/context (declaration time)
    blockManager.exit()
  }

  function it(title, fn) {
    addTestCallback(blockManager.currentSuite(), title, fn)
  }

  function xdescribe(title, fn) {
    var suite = addSkippedSuiteCallback(blockManager.currentSuite(), title)
    blockManager.enter(suite)
    fn.call(suite)
    blockManager.exit()
  }

  function createGivenLikeFunction(keyword) {
    return destructHashFor(keyword, function(assignTo, fn) {
      // Given(fn)
      if (!assignTo) {
        blockManager.addGivenToCurrent(resolveAction(fn))
        return
      }

      // Given(var, fn)
      blockManager.addGivenToCurrent(createLazyVar(assignTo, fn))
    })
  }

  function createLazyVar(varname, fn) {
    return function(ctx) {
      var cache = null,
          evaluated = false

      Object.defineProperty(ctx, varname, {
        configurable: true, // allow delete and redefine
        get: function() {
          if (!evaluated) {
            evaluated = true
            return cache = fn.call(ctx, ctx)
          }
          return cache
        },
        set: function(newVal) {
          evaluated = true
          cache = newVal
        }
      })
    }
  }

  function createImmediateGivenLikeFunction(keyword) {
    return destructHashFor(keyword, function(assignTo, fn) {
      // GivenI(fn)
      if (!assignTo) {
        blockManager.addGivenToCurrent(resolveAction(fn))
        return
      }

      // GivenI(result, fn)
      // GivenI(result, fn(done))
      blockManager.addGivenToCurrent(resolveActionToResult(fn, assignTo, true))
    })
  }

  var When = destructHashFor('When', function(assignTo, fn) {
    // When(fn)
    if (!assignTo) {
      blockManager.addWhenToCurrent(resolveAction(fn))
      return
    }

    // When(result, fn)
    // When(result, fn(done))
    blockManager.addWhenToCurrent(resolveActionToResult(fn, assignTo, false))
  })

  function destructHashFor(keyword, handler) {
    return function destructHashAndRunHandler() {
      // keyword(hash)
      if (u.isPlainObject(arguments[0])) {
        var hash = arguments[0]
        for (var key in hash)
          checkAndRun(key, hash[key])
        return
      }

      var assignTo = u.findFirstThatIsString(arguments),
          fn = u.findFirstThatIsFunction(arguments)

      checkAndRun(assignTo, fn)

      function checkAndRun(assignTo, fn) {
        if (typeof fn !== 'function') throw new Error(keyword + ': no function provided')
        fn._keyword = keyword
        handler(assignTo, fn)
      }
    }
  }

  function resolveAction(origFn) {
    return function(ctx, done) {
      var fn = isGeneratorFn(origFn) ? co.wrap(origFn) : origFn

      executeFunction(fn, ctx)
        .then(function(res){ done() })
        .catch(function(err) {
          done(createPreparationError(err, origFn))
        })
    }
  }

  function resolveActionToResult(fn, resultName, reportError) {
    return function(ctx, done) {
      fn = isGeneratorFn(fn) ? co.wrap(fn) : fn

      function assignResult(result) {
        ctx[resultName] = result
      }

      if (reportError) {
        executeFunction(fn, ctx)
          .then(assignResult)    // non-promise value or resolved promise value will arrive here
          .then(done)
          .catch(function(err) { // thrown Error or rejected Error will arrive here
            done(createPreparationError(err, fn))
          })
      } else {
        executeFunction(fn, ctx)
          .then(assignResult)  // non-promise value or resolved promise value will arrive here
          .catch(assignResult) // thrown Error or rejected Error will arrive here
          .then(done)
      }
    }
  }

  function executeFunction(fn, ctx) {
    return new Promise(function(resolve, reject) {
      if (fn.length > 1) {
        try {
          fn.call(ctx, ctx, function(err, res) { handler(err, res) })
        } catch (err) {
          reject(err)
        }
        return
      }

      try       { handler(null, fn.call(ctx, ctx)) }
      catch (e) { handler(e) }

      function handler(err, res) {
        var result = isObservable(res) ? observableToPromise(res) : res
        err ? reject(err) : resolve(result)
      }
    })
  }

  function createPreparationError(err, fn) {
    err = errorize(err)
    var msg = 'Failing expression: ' + documentationify(fn._keyword, fn) +
          '\n\n       Reason: ' + err.message + '\n'
    var newErr = new Error(msg)
    newErr.stack = err.stack
    return newErr
  }

  function errorize(err) {
    return err instanceof Error ? err : new Error(err)
  }

  function _Then(keyword, args) {
    var label = u.findFirstThatIsString(args),
        thenFn = createFnFromArgs(args, { keyword: keyword, meta: true }),
        finalLabel = label || documentationify(keyword, thenFn),
        givens = blockManager.allGivens(),
        whens = blockManager.allWhens(),
        invariants = blockManager.allInvariants(),
        ands = blockManager.currentAnds(),  // keep reference at this moment. `ands` is a empty array at this moment
        snapshot = blockManager.snapshot()

    blockManager.addThenToCurrent(thenFn)

    var finalFn = function(done) {
      // at this moment, all declaration actions are DONE
      // and the suite stack only contain 1 item: the out-most block.
      // so we can not use blockManager anymore
      // now all And are push into `ands` array, this is the time to concat it.
      function ContextObject() {}
      var ctx = new ContextObject;

      runPreparations()
        .then(runExpectations)
        .then(function() {
          return runCleanups().then(function() { done() })
        })
        .catch(function(e) {
          return runCleanups().then(function() { done(e) })
        })

      function runPreparations() {
        return sequencialExecute(givens.concat(whens), function(fn) {
          if (fn.length > 1)
            return toPromise(fn.bind(ctx, ctx))
          return fn.call(ctx, ctx)
        })
      }

      function runExpectations() {
        return sequencialExecute(invariants.concat(thenFn, ands), function(fn) {
          if (fn.call(ctx, ctx) === false)
            throw createNaturalAssertionError(fn, finalLabel, ctx, fn._keyword, fn._meta)
        })
      }

      function runCleanups() {
        var cleanups = snapshot.allCleanups()
        return sequencialExecute(cleanups, function(fn) {
          function noop() {}
          if (fn.length > 1)
            return toPromise(fn.bind(ctx, ctx)).catch(noop)
          return Promise.resolve().then(function(){
            return fn.call(ctx, ctx)
          }).catch(noop)
        })
      }
    }

    return {
      originalFn: thenFn,
      label: finalLabel,
      fn: finalFn
    }
  }

  function Then() {
    var thenData = _Then('Then', arguments)
    addTestCallback(blockManager.currentSuite(), thenData.label, thenData.fn)
  }

  function ThenError() {
    var thenData = _Then('ThenError', arguments)
    function flipResult(done) {
      thenData.fn(function(err) {
        if (!err) return done(new Error('expect an error but not'))
        return done()
      })
    }
    addTestCallback(blockManager.currentSuite(), thenData.label, flipResult)
  }

  function ThenFail() {
    var thenData = _Then('ThenFail', arguments)
    function flipResult(done) {
      thenData.fn(function(err) {
        if (!err) return done(new Error('expect an ExpectationNotMetError but not succeed'))
        if (!(err instanceof ExpectationNotMetError))
          return done(new Error('expect an ExpectationNotMetError but got ' + err.name))
        return done()
      })
    }
    addTestCallback(blockManager.currentSuite(), thenData.label, flipResult)
  }

  function sequencialExecute(fnArr, cb) {
    return fnArr.reduce(function(p, fn) {
      return p.then(function() { return cb(fn) })
    }, Promise.resolve())
  }

  function toPromise(fn) {
    return new Promise(function(resolve, reject) {
      fn(function(err, res) { err ? reject(err) : resolve(res) })
    })
  }

  function createNaturalAssertionError(fn, finalLabel, ctx, keyword, meta) {
    if (!meta)
      return createError.simple(fn, finalLabel, keyword)
    return createError.comprehensive(fn, finalLabel, ctx, keyword, meta)
  }

  function Invariant() {
    var fn = createFnFromArgs(arguments, { keyword: 'Invariant', meta: true })
    blockManager.addInvariantToCurrent(fn)
  }

  function And() {
    var fn = createFnFromArgs(arguments, { keyword: 'And', meta: true })
    if (!blockManager.hasAnyThen())
      throw new Error('cannot use And without Then')
    blockManager.addAndToCurrent(fn)
  }

  function Cleanup(fn) {
    blockManager.addCleanupToCurrent(fn)
  }

  function createFnFromArgs(args, opts) {
    opts = opts || {}
    var fn = u.findFirstThatIsFunction(args)
    if (opts.keyword)
      fn._keyword = opts.keyword
    if (opts.meta)
      fn._meta = u.findFirstThatIsPlainObject(args)
    return fn
  }

  return {
    describe: describe,
    xdescribe: xdescribe,
    it: it,

    Given: createGivenLikeFunction('Given'),
    Let: createGivenLikeFunction('Let'),
    GivenI: createImmediateGivenLikeFunction('GivenI'),
    LetI: createImmediateGivenLikeFunction('LetI'),
    When: When,
    Then: Then,
    Invariant: Invariant,
    And: And,
    Cleanup: Cleanup,

    ThenError: ThenError,
    ThenFail: ThenFail,

    Failure: matchers.Failure
  }
}

module.exports = {
  create: createCore
}
