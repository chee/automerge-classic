import * as assert from 'node:assert'
import * as Automerge from '..'
import {
  ActorId,
  Change,
  ChangeFn,
  ChangeOptions,
  DecodedChange,
  Mark,
  MarkRange,
  MarkSet,
  MarkValue,
  ObjID,
  PatchCallback,
  PatchInfo,
  Prop,
  RawString,
  SyncState,
  next as A,
} from '..'
import * as Slim from '@automerge/automerge-classic/slim'

interface DocumentValue {
  list: Automerge.List<string>
  text: string
  title: string
}

describe('modern API compatibility types', () => {
  it('types root, next, and slim entry points', () => {
    let doc = Automerge.init<DocumentValue>({actor: 'aabb'})
    doc = Automerge.change(doc, draft => {
      draft.list = ['one'] as Automerge.List<string>
      draft.text = 'hello'
      draft.title = 'hello'
      draft.list.insertAt(1, 'two')
      draft.list.deleteAt(1)
      Automerge.insertAt(draft.list, 1, 'two')
      Slim.updateText(draft, ['text'], 'world')
      Automerge.splice(draft, ['title'], 1, 2, 'i')
    })
    const heads: Automerge.Heads = Automerge.next.getHeads(doc)
    const view: Automerge.Doc<DocumentValue> = Automerge.view(doc, heads)
    const patches: Automerge.Patch[] = Slim.diff(doc, heads, heads)
    const cursor: Automerge.Cursor = Automerge.getCursor(doc, ['title'], 1)
    const bundle: Uint8Array = Automerge.saveBundle(doc, Automerge.next.getHeads(doc))
    const decodedBundle: Automerge.DecodedBundle = Automerge.readBundle(bundle)
    let nextDoc: A.Doc<DocumentValue> = A.init<DocumentValue>()
    const changeOptions: ChangeOptions<DocumentValue> = {message: 'next'}
    const changeFn: ChangeFn<DocumentValue> = draft => {
      draft.title = 'next'
    }
    nextDoc = A.change(nextDoc, changeOptions, changeFn)
    const actor: ActorId = Automerge.getActorId(doc)
    const objectId: ObjID = Automerge.getObjectId(doc)
    const change: Change = Automerge.getAllChanges(doc)[0]
    const decoded: DecodedChange = Automerge.decodeChange(change)
    const markValue: MarkValue = true
    const markSet: MarkSet = {bold: markValue}
    const mark: Mark = {name: 'bold', value: markValue, start: 0, end: 1}
    const markRange: MarkRange = {expand: 'both', start: 0, end: 1}
    const patchInfo: PatchInfo<DocumentValue> = {before: doc, after: nextDoc, source: 'change'}
    const patchCallback: PatchCallback<DocumentValue> = () => {}
    const path: Prop[] = ['title']
    const rawString: RawString = new RawString('raw')
    const syncState: SyncState = Automerge.initSyncState()
    Automerge.applyPatches({}, patches)
    patchCallback([], patchInfo)
    assert.strictEqual(Automerge.getCursorPosition(doc, ['title'], cursor), 1)
    assert.strictEqual(A.getHeads(nextDoc).length, 1)
    assert.strictEqual(actor.length > 0, true)
    assert.strictEqual(Automerge.decodeChange(change).hash, decoded.hash)
    assert.strictEqual(markSet.bold, mark.value)
    assert.strictEqual(markRange.expand, 'both')
    assert.strictEqual(patchInfo.after.title, 'next')
    assert.strictEqual(path[0], 'title')
    assert.strictEqual(rawString.toString(), 'raw')
    assert.ok(syncState)
    assert.strictEqual(view.text.toString(), 'world')
    assert.strictEqual(decodedBundle.changes.length, 1)
  })
})
