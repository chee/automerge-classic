import assert from 'node:assert'
import uuid from '../src/uuid.js'

describe('uuid', () => {
  afterEach(() => {
    uuid.reset()
  })

  describe('default implementation', () => {
    it('generates unique values', () => {
      assert.notEqual(uuid(), uuid())
    })
  })

  describe('custom implementation', () => {
    let counter

    function customUuid() {
      return `custom-uuid-${counter++}`
    }

    beforeAll(() => uuid.setFactory(customUuid))
    beforeEach(() => counter = 0)

    it('invokes the custom factory', () => {
      assert.equal(uuid(), 'custom-uuid-0')
      assert.equal(uuid(), 'custom-uuid-1')
    })
  })
})
