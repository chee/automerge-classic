"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || function (mod) {
    if (mod && mod.__esModule) return mod;
    var result = {};
    if (mod != null) for (var k in mod) if (k !== "default" && Object.prototype.hasOwnProperty.call(mod, k)) __createBinding(result, mod, k);
    __setModuleDefault(result, mod);
    return result;
};
Object.defineProperty(exports, "__esModule", { value: true });
const assert = __importStar(require("assert"));
const Automerge = __importStar(require(".."));
const __1 = require("..");
const Slim = require('../src/slim');
describe('modern API compatibility types', () => {
    it('types root, next, and slim entry points', () => {
        let doc = Automerge.init({ actor: 'aabb' });
        doc = Automerge.change(doc, draft => {
            draft.list = ['one'];
            draft.text = new Automerge.Text('hello');
            draft.title = 'hello';
            draft.list.insertAt(1, 'two');
            draft.list.deleteAt(1);
            Automerge.insertAt(draft.list, 1, 'two');
            Slim.updateText(draft, ['text'], 'world');
            Automerge.splice(draft, ['title'], 1, 2, 'i');
        });
        const heads = Automerge.next.getHeads(doc);
        const view = Automerge.view(doc, heads);
        const patches = Slim.diff(doc, heads, heads);
        const diffOptions = { recursive: false };
        const nestedPatches = Automerge.diffPath(doc, ['title'], heads, heads, diffOptions);
        const cursor = Automerge.getCursor(doc, ['title'], 1);
        const fragments = Automerge.getFragmentMetadata(doc, { start: 0, end: 1 });
        const bundles = Automerge.bundleFragmentMetadata(doc, fragments);
        const commits = Automerge.getCommits(doc);
        const imported = Automerge.addCommits(Automerge.init(), commits);
        let nextDoc = __1.next.init();
        const changeOptions = { message: 'next' };
        const changeFn = draft => {
            draft.title = 'next';
        };
        nextDoc = __1.next.change(nextDoc, changeOptions, changeFn);
        const actor = Automerge.getActorId(doc);
        const objectId = Automerge.getObjectId(doc);
        const change = Automerge.getAllChanges(doc)[0];
        const decoded = Automerge.decodeChange(change);
        const markValue = true;
        const markSet = { bold: markValue };
        const mark = { name: 'bold', value: markValue, start: 0, end: 1 };
        const markRange = { expand: 'both', start: 0, end: 1 };
        const patchInfo = { before: doc, after: nextDoc, source: 'change' };
        const patchCallback = () => { };
        const path = ['title'];
        const rawString = new __1.RawString('raw');
        const syncState = Automerge.initSyncState();
        const release = Automerge.releaseInfo();
        Automerge.addFragments(imported, Automerge.getFragments(doc, 0));
        Automerge.applyPatches({}, patches);
        patchCallback([], patchInfo);
        assert.strictEqual(Automerge.getCursorPosition(doc, ['title'], cursor), 1);
        assert.strictEqual(__1.next.getHeads(nextDoc).length, 1);
        assert.strictEqual(actor.length > 0, true);
        assert.strictEqual(Automerge.decodeChange(change).hash, decoded.hash);
        assert.strictEqual(markSet.bold, mark.value);
        assert.strictEqual(markRange.expand, 'both');
        assert.strictEqual(patchInfo.after.title, 'next');
        assert.strictEqual(path[0], 'title');
        assert.strictEqual(rawString.toString(), 'raw');
        assert.ok(syncState);
        assert.strictEqual(view.text.toString(), 'world');
        assert.strictEqual(bundles.length, fragments.length);
        assert.strictEqual(nestedPatches.length, 0);
        assert.strictEqual(release.js.gitHead.length > 0, true);
    });
});
