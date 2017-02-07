const {EditorState} = require("prosemirror-state")
const {MenuBarEditorView} = require("prosemirror-menu")
const {DOMParser, Schema} = require("prosemirror-model")
const {schema: baseSchema} = require("prosemirror-schema-basic")
const {addListNodes} = require("prosemirror-schema-list")
const {exampleSetup} = require("prosemirror-example-setup")

const {Mapping} = require("prosemirror-transform")
const crel = require("crel")
const {trackPlugin, highlightPlugin} = require('./track1')

const schema = new Schema({
  nodes: addListNodes(baseSchema.nodeSpec, "paragraph block*", "block"),
  marks: baseSchema.markSpec
})

let content = document.querySelector("#content")
content.style.display = "none"

let tip = document.querySelector(".demotip")

let state = EditorState.create({
  doc: DOMParser.fromSchema(schema).parse(content),
  plugins: exampleSetup({schema}).concat([trackPlugin, highlightPlugin])
})

let view = new MenuBarEditorView(document.querySelector("#editor"), {
  state: state,
  dispatchTransaction: dispatch,
  // onFocus() {
  //   if (tip) {
  //     tip.innerHTML = "<a href='#demos' style='text-decoration: none; pointer-events: auto; color: inherit'>Find more demos below ↓</a>"
  //     tip = null
  //   }
  // }
})
window.view = view.editor






// TRACK SETUP

// let state = EditorState.create({
//   schema,
//   plugins: exampleSetup({schema}).concat(trackPlugin, highlightPlugin)
// }), view

let lastRendered = null

function dispatch(tr) {
  state = state.apply(tr)
  view.updateState(state)
  // setDisabled(state)
  renderCommits(state, dispatch)
}

// view = new MenuBarEditorView(document.querySelector("#editor"), {state, dispatchTransaction: dispatch})
// window.view = view.editor

// setTimeout(() => {
  dispatch(state.tr.insertText("Type something, and then commit it."))
  dispatch(state.tr.setMeta(trackPlugin, "Initial commit"))
// }, 50)


function setDisabled(state) {
  let input = document.querySelector("#message")
  let button = document.querySelector("#commitbutton")
  input.disabled = button.disabled = trackPlugin.getState(state).uncommittedSteps.length == 0
}

function doCommit(message) {
  dispatch(state.tr.setMeta(trackPlugin, message))
}

function renderCommits(state, dispatch) {
  let curState = trackPlugin.getState(state)
  if (lastRendered == curState) return
  lastRendered = curState

  let out = document.querySelector("#commits")
  out.textContent = ""
  let commits = curState.commits
  commits.forEach(commit => {
    let node = crel("div", {class: "commit"},
        crel("span", {class: "commit-time"},
            commit.time.getHours() + ":" + (commit.time.getMinutes() < 10 ? "0" : "")
            + commit.time.getMinutes()),
        "\u00a0 " + commit.message + "\u00a0 ",
        crel("button", {class: "commit-revert"}, "revert"))
    node.lastChild.addEventListener("click", () => revertCommit(commit))
    node.addEventListener("mouseover", e => {
      if (!node.contains(e.relatedTarget))
        dispatch(state.tr.setMeta(highlightPlugin, {add: commit}))
    })
    node.addEventListener("mouseout", e => {
      if (!node.contains(e.relatedTarget))
        dispatch(state.tr.setMeta(highlightPlugin, {clear: commit}))
    })
    out.appendChild(node)
  })
}

function revertCommit(commit) {
  let tState = trackPlugin.getState(state)
  let found = tState.commits.indexOf(commit)
  if (found == -1) return

  if (tState.uncommittedSteps.length) return alert("Commit your changes first!")

  let remap = new Mapping(tState.commits.slice(found).reduce((maps, c) => maps.concat(c.maps), []))
  let tr = state.tr
  for (let i = commit.steps.length - 1; i >= 0; i--) {
    let remapped = commit.steps[i].map(remap.slice(i + 1))
    let result = remapped && tr.maybeStep(remapped)
    if (result && result.doc) remap.appendMap(remapped.getMap(), i)
  }
  if (tr.docChanged) {
    dispatch(tr.setMeta(trackPlugin, `Revert '${commit.message}'`))
  }
}

document.querySelector("#commit").addEventListener("submit", e => {
  e.preventDefault()
  doCommit(e.target.elements.message.value || "Unnamed")
  e.target.elements.message.value = ""
  view.editor.focus()
})

function findInBlameMap(pos, state) {
  let map = trackPlugin.getState(state).blameMap
  for (let i = 0; i < map.length; i++)
    if (map[i].to >= pos && map[i].commit != null)
      return map[i].commit
}

document.querySelector("#blame").addEventListener("mousedown", e => {
  e.preventDefault()
  let pos = e.target.getBoundingClientRect()
  let commitID = findInBlameMap(state.selection.head, state)
  let commit = commitID != null && trackPlugin.getState(state).commits[commitID]
  let node = crel("div", {class: "blame-info"},
      commitID != null ? ["It was: ", crel("strong", null, commit ? commit.message : "Uncommitted")]
          : "No commit found")
  node.style.right = (document.body.clientWidth - pos.right) + "px"
  node.style.top = (pos.bottom + 2) + "px"
  document.body.appendChild(node)
  setTimeout(() => document.body.removeChild(node), 2000)
})
