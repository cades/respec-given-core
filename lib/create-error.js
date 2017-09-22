var documentationify = require('./documentationify'),
    stringify = require('stringifier').stringify,
    ExpectationNotMetError = require('./ExpectationNotMetError')

function createComprehensiveError(fn, finalLabel, ctx, keyword, meta) {
  var pos = meta.loc.start.line + ':' + meta.loc.start.column,
      msg = finalLabel + '\n\n',
      lines = [],
      paddingLen = 7,
      padding = spaceOf(paddingLen),
      keywordPaddingLen = keyword.length + 3

  msg += padding + keyword + ' expression failed at ' + meta.filepath.replace(process.cwd() + '/', '') + ':' + pos + '\n\n'
  msg += padding + documentationify(keyword, fn) + '\n'

  if (meta.evaluators.length === 0)
    return new ExpectationNotMetError(msg)

  var metaMeta = meta.evaluators
        .map(function(o) {
          var result = o.evaluator.call(ctx, ctx),
              resultStr = stringify(result)
          return {
            resultStr: resultStr,
            paddingLen: findExpPaddingLen(o.position)
          }
        })
        .sort(function(a, b) { return a.paddingLen < b.paddingLen }) // 從大到小排序

  var firstLine = metaMeta
        .reduce(function(line, o, idx, arr) {
          // 第一行, 最單純的狀況. 只印 |
          if (idx === 0) return ''
          var paddingLenDiff = arr[idx-1].paddingLen - arr[idx].paddingLen
          if (paddingLenDiff === 0) return line
          return spaceOf( paddingLenDiff - 1 ) + '|' + line  // 兩個 padding 的差
        }, '')

  lines.push('|' + firstLine)

  metaMeta
    .forEach(function(o, idx, arr) {
      var line = '',
          needNextLine = false

      if (o.printed) return

      arr.forEach(function(innerO, innerIdx, arr) {
        if (innerIdx < idx) return

        if (isAtRightMost()) {
          line = resultStr() + line
          curr().printed = true
        } else if (!needNextLine && spaceIsEnough()) {
          line = spaceOf( getPaddingLenDiffToPrev() - resultStrLen() ) + line
          line = resultStr() + line
          curr().printed = true
        } else {
          needNextLine = true
          var paddingLenDiffToPrev = getPaddingLenDiffToPrev()
          if (paddingLenDiffToPrev === 0) return
          line = spaceOf( paddingLenDiffToPrev - 1 ) + line
          line = '|' + line
        }

        function spaceIsEnough() {
          if (isAtRightMost()) return true
          return getPaddingLenDiffToPrev() > resultStrLen()
        }

        function resultStrLen() { return resultStr().length }
        function resultStr() { return curr().resultStr }
        function isAtRightMost() { return innerIdx === idx }
        function getPaddingLenDiffToPrev() { return prev().paddingLen - curr().paddingLen }
        function curr() { return innerO }
        function prev() { return arr[innerIdx-1] }
      })

      lines.push(line)
    })

  msg += lines.map(function(line) {
    return spaceOf( paddingLen + keywordPaddingLen + metaMeta[metaMeta.length - 1].paddingLen ) + line
  }).reduce(function(str, line) {
    return str + line + '\n'
  }, '')

  function findExpPaddingLen(position) {
    return position - meta.loc.start.column
  }
  function spaceOf(n) { return ' '.repeat(n) }

  msg += '\n'

  if (meta.isBinaryExpression) {
    var relation = (function(op){
      if (op === '==') return 'to equal'
      if (op === '===') return 'to strictly equal'
      if (op === '!=') return 'to not equal'
      if (op === '!==') return 'to strictly not equal'
      if (op === '>') return 'to be greater than'
      if (op === '>=') return 'to be greater or equal to'
      if (op === '<') return 'to be less than'
      if (op === '<=') return 'to be less than or equal to'
      return null
    }(meta.operator))

    if (relation) {
      var paddingSpace = spaceOf(relation.length - 'expected'.length)
      msg += '       ' + paddingSpace + 'expected: ' + meta.left.call(ctx, ctx) + '\n' // run on same context
      msg += '       ' + relation + ': ' + meta.right.call(ctx, ctx) + '\n'            // run on same context
    }
  }
  return new ExpectationNotMetError(msg)
}

function createSimpleError(fn, finalLabel, keyword) {
  var msg = finalLabel + '\n'
  if (keyword !== 'Then')
    msg += '\n       Failing expression: ' + documentationify(keyword, fn) + '\n'

  return new ExpectationNotMetError(msg)
}

module.exports = {
  comprehensive: createComprehensiveError,
  simple: createSimpleError
}
