import assert from 'node:assert'
import Automerge from './subject.js'

const { ImmutableString } = Automerge

describe('blocks', () => {
  it('splits a block', () => {
    const block = {parents: ['div'], type: 'p', attrs: {}}
    const callbacks = []
    function patchCallback(patches) { callbacks.push(patches) }
    let doc = Automerge.from({text: 'aaabbbccc'})
    doc = Automerge.change(doc, {patchCallback}, d => {
      Automerge.splitBlock(d, ['text'], 3, block)
    })

    assert.deepStrictEqual(Automerge.block(doc, ['text'], 3), block)
    assert.deepStrictEqual(callbacks[0][0], {action: 'insert', path: ['text', 3], values: [{}]})
    assert.deepStrictEqual(Automerge.spans(doc, ['text']), [
      {type: 'text', value: 'aaa'},
      {type: 'block', value: block},
      {type: 'text', value: 'bbbccc'}
    ])

    doc = Automerge.change(doc, {patchCallback}, d => {
      Automerge.splice(d, ['text'], 7, 0, 'ADD')
    })
    assert.deepStrictEqual(callbacks[1], [{action: 'splice', path: ['text', 7], value: 'ADD'}])

    doc = Automerge.change(doc, {patchCallback}, d => {
      Automerge.splice(d, ['text'], 0, 7, 'REMOVE')
    })
    assert.deepStrictEqual(Automerge.spans(doc, ['text']), [{type: 'text', value: 'REMOVEADDccc'}])
  })

  it('joins a block', () => {
    const block = {parents: ['div'], type: 'p', attrs: {}}
    let doc = Automerge.from({text: 'aaabbbccc'})
    doc = Automerge.change(doc, d => { Automerge.splitBlock(d, ['text'], 3, block) })
    doc = Automerge.change(doc, d => { Automerge.joinBlock(d, ['text'], 3) })
    assert.deepStrictEqual(Automerge.spans(doc, ['text']), [{type: 'text', value: 'aaabbbccc'}])
  })

  it('updates a block in place', () => {
    let doc = Automerge.from({text: ''})
    doc = Automerge.change(doc, d => {
      Automerge.splitBlock(d, ['text'], 0, {parents: [], type: 'paragraph', attrs: {}})
      Automerge.splice(d, ['text'], 1, 0, 'hello')
    })
    doc = Automerge.change(doc, d => {
      Automerge.updateBlock(d, ['text'], 0, {parents: [], type: 'heading', attrs: {level: 1}})
    })
    assert.deepStrictEqual(Automerge.block(doc, ['text'], 0),
      {parents: [], type: 'heading', attrs: {level: 1}})
    assert.deepStrictEqual(Automerge.block(Automerge.load(Automerge.save(doc)), ['text'], 0),
      {parents: [], type: 'heading', attrs: {level: 1}})
  })

  it('returns null for a block index that holds text', () => {
    let doc = Automerge.from({text: 'abc'})
    assert.strictEqual(Automerge.block(doc, ['text'], 0), null)
    assert.strictEqual(Automerge.block(doc, ['text'], 3), null)
  })

  it('allows small values in block attributes', () => {
    const smallnum = 1.401298464324817e-45
    let doc = Automerge.from({text: ''})
    doc = Automerge.change(doc, d => { Automerge.splitBlock(d, ['text'], 0, {smallnum}) })
    assert.strictEqual(Automerge.block(doc, ['text'], 0).smallnum, smallnum)
    assert.strictEqual(Automerge.block(Automerge.load(Automerge.save(doc)), ['text'], 0).smallnum, smallnum)
  })

  describe('updateSpans', () => {
    it('updates all blocks at once', () => {
      let doc = Automerge.from({text: ''})
      doc = Automerge.change(doc, d => {
        Automerge.splitBlock(d, ['text'], 0, {parents: [], type: 'ordered-list-item', attrs: {}})
        Automerge.splice(d, ['text'], 1, 0, 'first thing')
        Automerge.splitBlock(d, ['text'], 7, {parents: [], type: 'ordered-list-item', attrs: {}})
        Automerge.splice(d, ['text'], 8, 0, 'second thing')
      })

      doc = Automerge.change(doc, d => {
        Automerge.updateSpans(d, ['text'], [
          {type: 'block', value: {type: 'paragraph', parents: [], attrs: {}}},
          {type: 'text', value: 'the first thing'},
          {type: 'block', value: {type: 'unordered-list-item', parents: ['ordered-list-item'], attrs: {}}},
          {type: 'text', value: 'the second thing'}
        ])
      })

      assert.deepStrictEqual(Automerge.spans(doc, ['text']), [
        {type: 'block', value: {type: 'paragraph', parents: [], attrs: {}}},
        {type: 'text', value: 'the first thing'},
        {type: 'block', value: {type: 'unordered-list-item', parents: ['ordered-list-item'], attrs: {}}},
        {type: 'text', value: 'the second thing'}
      ])
    })

    it('emits insert patches with ImmutableString for attribute updates', () => {
      let doc = Automerge.from({text: ''})
      doc = Automerge.change(doc, d => {
        Automerge.splitBlock(d, ['text'], 0, {parents: [], type: 'paragraph', attrs: {}})
      })
      const patches = []
      Automerge.change(doc, {patchCallback: p => patches.push(...p)}, d => {
        Automerge.updateSpans(d, ['text'], [
          {type: 'block', value: {type: 'paragraph', parents: [new ImmutableString('someparent')], attrs: {}}}
        ])
      })
      assert.deepStrictEqual(patches, [
        {action: 'insert', path: ['text', 0, 'parents', 0], values: [new ImmutableString('someparent')]}
      ])
    })

    it('updates marks', () => {
      let doc = Automerge.from({text: 'hello world'})
      doc = Automerge.change(doc, d => {
        Automerge.updateSpans(d, ['text'], [
          {type: 'text', value: 'hello', marks: {bold: true}},
          {type: 'text', value: ' '},
          {type: 'text', value: ' world', marks: {italic: true}}
        ])
      })
      assert.deepStrictEqual(Automerge.spans(doc, ['text']), [
        {type: 'text', value: 'hello', marks: {bold: true}},
        {type: 'text', value: ' '},
        {type: 'text', value: ' world', marks: {italic: true}}
      ])
    })

    it('configures the default expand value of created marks', () => {
      let doc = Automerge.from({text: ''})
      doc = Automerge.change(doc, d => {
        Automerge.updateSpans(d, ['text'], [
          {type: 'text', value: 'hello', marks: {bold: true}},
          {type: 'text', value: ' world'}
        ], {defaultExpand: 'none'})
      })
      doc = Automerge.change(doc, d => { Automerge.splice(d, ['text'], 5, 0, '!') })
      assert.deepStrictEqual(Automerge.spans(doc, ['text']), [
        {type: 'text', value: 'hello', marks: {bold: true}},
        {type: 'text', value: '! world'}
      ])
    })

    it('overrides the default expand per mark', () => {
      let doc = Automerge.from({text: ''})
      doc = Automerge.change(doc, d => {
        Automerge.updateSpans(d, ['text'], [
          {type: 'text', value: 'hello', marks: {bold: true}},
          {type: 'text', value: ' world'}
        ], {defaultExpand: 'none', perMarkExpand: {bold: 'both'}})
      })
      doc = Automerge.change(doc, d => { Automerge.splice(d, ['text'], 5, 0, '!') })
      assert.deepStrictEqual(Automerge.spans(doc, ['text']), [
        {type: 'text', value: 'hello!', marks: {bold: true}},
        {type: 'text', value: ' world'}
      ])
    })

    it('allows omitting any part of the config', () => {
      let doc = Automerge.from({text: ''})
      const spans = [
        {type: 'text', value: 'hello', marks: {bold: true}},
        {type: 'text', value: ' world'}
      ]
      doc = Automerge.change(doc, d => { Automerge.updateSpans(d, ['text'], spans, {defaultExpand: 'none'}) })
      doc = Automerge.change(doc, d => { Automerge.updateSpans(d, ['text'], spans, {perMarkExpand: {bold: 'none'}}) })
      doc = Automerge.change(doc, d => { Automerge.updateSpans(d, ['text'], spans) })
      assert.deepStrictEqual(Automerge.spans(doc, ['text']), spans)
    })
  })

  describe('ImmutableString in block attributes', () => {
    it('reads them back from block()', () => {
      let doc = Automerge.from({text: ''})
      doc = Automerge.change(doc, d => {
        Automerge.splitBlock(d, ['text'], 0, {
          parents: [],
          type: new ImmutableString('ordered-list-item'),
          attrs: {'data-foo': new ImmutableString('someval')}
        })
        Automerge.splice(d, ['text'], 1, 0, 'first thing')
      })
      const block = Automerge.block(doc, ['text'], 0)
      assert.deepStrictEqual(block.attrs, {'data-foo': new ImmutableString('someval')})
    })

    it('reads them back from spans()', () => {
      let doc = Automerge.from({text: ''})
      doc = Automerge.change(doc, d => {
        Automerge.splitBlock(d, ['text'], 0, {
          parents: [new ImmutableString('div')],
          type: new ImmutableString('ordered-list-item'),
          attrs: {'data-foo': new ImmutableString('someval')}
        })
        Automerge.splice(d, ['text'], 1, 0, 'first thing')
      })
      const block = Automerge.spans(doc, ['text'])[0]
      assert.strictEqual(block.type, 'block')
      assert.deepStrictEqual(block.value.parents, [new ImmutableString('div')])
      assert.deepStrictEqual(block.value.attrs, {'data-foo': new ImmutableString('someval')})
      assert.deepStrictEqual(block.value.type, new ImmutableString('ordered-list-item'))
    })

    it('stays usable when the only change was a block attribute', () => {
      let doc = Automerge.from({text: ''})
      doc = Automerge.change(doc, d => {
        Automerge.splitBlock(d, ['text'], 0, {parents: [], type: 'paragraph', attrs: {}})
        Automerge.splice(d, ['text'], 1, 0, 'item')
      })
      doc = Automerge.change(doc, d => {
        Automerge.updateSpans(d, ['text'], [
          {type: 'block', value: {type: 'paragraph', parents: ['ordered-list-item'], attrs: {}}},
          {type: 'text', value: 'item'}
        ])
      })
      assert.deepStrictEqual(Automerge.spans(doc, ['text']), [
        {type: 'block', value: {type: 'paragraph', parents: ['ordered-list-item'], attrs: {}}},
        {type: 'text', value: 'item'}
      ])
      // splicing over index 0 deletes the block marker itself
      const spliced = Automerge.change(doc, d => { Automerge.splice(d, ['text'], 0, 1, 'A') })
      assert.deepStrictEqual(Automerge.spans(spliced, ['text']), [{type: 'text', value: 'Aitem'}])
    })
  })

  describe('views', () => {
    it('shows historical marks', () => {
      let doc = Automerge.from({text: 'hello world'})
      doc = Automerge.change(doc, d => {
        Automerge.mark(d, ['text'], {start: 0, end: 5}, 'bold', true)
      })
      const headsBefore = Automerge.getHeads(doc)
      doc = Automerge.change(doc, d => {
        Automerge.mark(d, ['text'], {start: 5, end: 11}, 'italic', true)
      })
      assert.deepStrictEqual(Automerge.spans(Automerge.view(doc, headsBefore), ['text']), [
        {type: 'text', value: 'hello', marks: {bold: true}},
        {type: 'text', value: ' world'}
      ])
    })
  })
})
