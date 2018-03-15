const assert = require('assert')
const ofac = require('../../lib/ofac')
const fs = require('fs')
const path = require('path')
const _ = require('lodash/fp')

let structs
let fullNames

const rand = N => _.random(0, N - 1)

const letters = _.range('a'.charCodeAt(0), 'z'.charCodeAt(0))
const vowels = _.map(c => c.charCodeAt(0), ['a', 'e', 'i', 'o', 'u'])
const consonants = _.difference(letters, vowels)

const duplicate = (word, index) => {
  const c = word[index]
  return _.join('', [word.slice(0, index), c, c, word.slice(index + 1)])
}

const remove = (word, index) => {
  return _.join('', [word.slice(0, index), word.slice(index + 1)])
}

const transpose = (word, index) => {
  const a = word[index]
  const b = word[index + 1] || ' '
  return _.join('', [word.slice(0, index), b, a, word.slice(index + 2)])
}

const alter = (word, index) => {
  const o = word.charCodeAt(index)
  const collection = _.includes(o, vowels) ? vowels : consonants
  const oo = _.sample(collection)
  const cc = String.fromCharCode(oo)
  return _.join('', [word.slice(0, index), cc, word.slice(index + 1)])
}

const misspellOps = [
  duplicate,
  remove,
  transpose,
  alter
]

const misspell = word => {
  const len = word.length
  const index = _.random(1, len)
  const operation = _.sample(misspellOps)
  return operation(word, index)
}

const misspellRandomly = word => {
  const len = word.length
  const num = _.random(1, Math.sqrt(len))
  return _.flow(..._.times(() => misspell, num))(word)
}


const shiftVowel = word => {
  const indexedVowels = _.flow(
    _.get('length'),
    _.range(0),
    _.zip(_.split('', word)),
    _.map(_.zipObject(['letter', 'index'])),
    _.map(indexedLetter => {
      const ord = indexedLetter.letter.charCodeAt(0)
      const vowelIndex = _.indexOf(ord, vowels)
      return {...indexedLetter, vowelIndex}
    }),
    _.reject(_.flow(
      _.get('vowelIndex'),
      _.eq(-1)
    ))
  )(word)

  if (_.isEmpty(indexedVowels)) return false

  const indexedVowel = _.sample(indexedVowels)
  const options = indexedVowel.vowelIndex === 0 ? [ +1 ]
                : indexedVowel.vowelIndex === 4 ? [ -1 ]
                : [ -1, +1 ]
  const offset = _.sample(options)
  const replacementOrd = vowels[indexedVowel.vowelIndex + offset]
  const replacement = String.fromCharCode(replacementOrd)

  const index = indexedVowel.index
  return _.join('', [word.slice(0, index), replacement, word.slice(index + 1)])
}

const makeReplacer = (a, b) => word => {
  const replaced = word.replace(a, b)
  return (replaced !== word) && replaced
}

const makeReplacerPair = (a, b) => [
  makeReplacer(a, b),
  makeReplacer(b, a),
]

const equivalences = [
  shiftVowel,
  ...makeReplacerPair('v', 'f'),
  ...makeReplacerPair('ph', 'f'),
  ...makeReplacerPair('ck', 'k'),
  ...makeReplacerPair('q', 'k')
]

const transcribe = word => {
  const ops = _.shuffle(equivalences)
  for (const op of ops) {
    const transcribed = op(word)
    if (transcribed) return transcribed
  }
}

const threshold = 0.85

describe('OFAC', function () {
  describe('Matching', function () {

    before(function () {
      this.timeout(60000)
      return ofac.load()
        .then(result => {
          structs = result
          const {individuals} = structs
          fullNames = _.flow(
            _.flatMap('aliases'),
            _.map('fullName')
          )(individuals)
        })
    })

    it('should match the exact full names of suspects', function () {
      this.timeout(0)

      for (const fullName of fullNames) {
        const matches = ofac.match({firstName: fullName}, null, {
          threshold,//: 1
        })
        assert.ok(!_.isEmpty(matches))
      }
    })

    it('should match the permutated full names of suspects', function () {
      this.timeout(0)

      for (const fullName of fullNames) {
        const reversed = _.flow(
          _.split(' '),
          _.reverse,
          _.join(' ')
        )(fullName)

        const matches = ofac.match({firstName: reversed}, null, {
          threshold,//: 1
        })
        assert.ok(!_.isEmpty(matches))
      }
    })

    it('should match despite some misspellings', function () {
      this.timeout(0)

      for (const fullName of fullNames) {
        const lightlyMisspelled = misspell(fullName)

        const heavilyMisspelled = _.flow(
          _.split(' '),
          _.map(misspell),
          _.join(' ')
        )(fullName)

        const matchesA = ofac.match({firstName: lightlyMisspelled}, null, {
          threshold,//: 0.875
        })
        if (_.isEmpty(matchesA)) {
          console.log(fullName)
          ofac.match({firstName: lightlyMisspelled}, null, {
            threshold,//: 0.875,
            debug: true
          })
        }
        assert.ok(!_.isEmpty(matchesA))

        const matchesB = ofac.match({firstName: heavilyMisspelled}, null, {
          threshold: threshold - 0.1,//: 0.75
        })
        if (_.isEmpty(matchesB)) {
          console.log(fullName)
          ofac.match({firstName: heavilyMisspelled}, null, {
            threshold: threshold - 0.1,//: 0.75,
            debug: true
          })
        }
        assert.ok(!_.isEmpty(matchesB))
      }
    })

    it('should match phonetically similar words', function () {
      this.timeout(0)

      for (const fullName of fullNames) {
        const transcribed = transcribe(fullName)

        if (!transcribed) {
          console.warn(`Couldn't find an appropriate phonetic alteration for '${fullName}'`)
          continue
        }

        const matches = ofac.match({firstName: transcribed}, null, {
          threshold,//: 0.85
        })
        if (_.isEmpty(matches)) {
          console.log(fullName)
          ofac.match({firstName: transcribed}, null, {
            threshold,//: 0.85,
            debug: true
          })
        }
        assert.ok(!_.isEmpty(matches))
      }
    })

    it('should discard matches with inapropriate birthdates', function () {
      this.timeout(0)

      const date = new Date()
      const YYYY = _.padCharsStart('0', 4, date.getFullYear())
      const MM = _.padCharsStart('0', 2, date.getMonth() + 1)
      const DD = _.padCharsStart('0', 2, date.getDate())
      const dateString = `${YYYY}${MM}${DD}`

      const noMatchesWithBirthDates = _.every(_.flow(
        _.get('birthDatePeriods'),
        _.every(_.isEmpty)
      ))

      for (const fullName of fullNames) {
        const matches = ofac.match({firstName: fullName}, dateString, {
          threshold,//: 1
        })
        assert.ok(noMatchesWithBirthDates(matches))
      }
    })

    it('should not match against common names', function () {
      this.timeout(0)

      const getNamesFromFile = _.flow(
        name => path.resolve(__dirname, name),
        file => fs.readFileSync(file, 'utf-8'),
        _.split('\n'),
        _.map( _.flow(
          _.split(' '),
          _.first
        ))
      )

      const lastNames = getNamesFromFile('dist.all.last.txt')
      const firstNamesMale = getNamesFromFile('dist.male.first.txt')
      const firstNamesFemale = getNamesFromFile('dist.female.first.txt')

      for (const lastName of lastNames.slice(0, 100)) {
        for (firstName of firstNamesMale.slice(0, 100)) {
          const matches = ofac.match({firstName, lastName}, null, {
            threshold,//: 0.875
          })
          if (!_.isEmpty(matches)) {
            ofac.match({firstName, lastName}, null, {
              threshold,//: 0.875,
              debug: true
            })
          }
          assert.ok(_.isEmpty(matches))
        }

        for (firstName of firstNamesFemale.slice(0, 100)) {
          const matches = ofac.match({firstName, lastName}, null, {
            threshold,//: 0.875
          })
          if (!_.isEmpty(matches)) {
            ofac.match({firstName, lastName}, null, {
              threshold,//: 0.875,
              debug: true
            })
          }
          assert.ok(_.isEmpty(matches))
        }
      }
    })


    it.skip('test', function () {
      const firstName = 'hian chariapaporn'
      ofac.match({firstName}, null, {
        threshold,//: 0.875,
        debug: true,
        verboseFor: ['hiran', 'chariapaporn']
      })
    })

  })
})
