const {exampleSetup, buildMenuItems} = require("prosemirror-example-setup")
const {Step} = require("prosemirror-transform")
const {MenuBarEditorView} = require("prosemirror-menu")
const {EditorState} = require("prosemirror-state")
const {history} = require("prosemirror-history")
const {collab, receiveTransaction, sendableSteps, getVersion} = require("prosemirror-collab")
const {MenuItem} = require("prosemirror-menu")
const crel = require("crel")

const {schema} = require("../schema")
const {GET, POST} = require("./http")
const {Reporter} = require("./reporter")
const {commentPlugin, commentUI, addAnnotation, annotationIcon} = require("./comment")

const {Mapping} = require("prosemirror-transform")
const {trackPlugin, highlightPlugin} = require('./track')

const report = new Reporter()

function badVersion(err) {
  return err.status == 400 && /invalid version/i.test(err)
}

class State {
  constructor(edit, comm) {
    this.edit = edit
    this.comm = comm
  }
}

class EditorConnection {
  constructor(report, url) {
    this.report = report
    this.url = url
    this.state = new State(null, "start")
    this.request = null
    this.backOff = 0
    this.view = null
    this.dispatch = this.dispatch.bind(this)
    this.start()
  }

  // All state changes go through this
  dispatch(action) {
    let newEditState = null
    if (action.type == "loaded") {
      info.users.textContent = userString(action.users) // FIXME ewww
      let editState = EditorState.create({
        doc: action.doc,
        plugins: exampleSetup({schema, history: false}).concat([
          history({preserveItems: true}),
          collab({version: action.version}),
          trackPlugin,
          highlightPlugin,
          commentPlugin,
          commentUI({dispatch: transaction => this.dispatch({type: "transaction", transaction}),
                     getState: () => this.state.edit})
        ]),
        comments: action.comments
      })
      this.state = new State(editState, "poll")
      this.poll()
    } else if (action.type == "restart") {
      this.state = new State(null, "start")
      this.start()
    } else if (action.type == "poll") {
      this.state = new State(this.state.edit, "poll")
      this.poll()
    } else if (action.type == "recover") {
      if (action.error.status && action.error.status < 500) {
        this.report.failure(err)
        this.state = new State(null, null)
      } else {
        this.state = new State(this.state.edit, "recover")
        this.recover(action.error)
      }
    } else if (action.type == "transaction") {
      newEditState = this.state.edit.apply(action.transaction)
    }

    if (newEditState) {
      let sendable
      if (newEditState.doc.content.size > 40000) {
        if (this.state.comm != "detached") this.report.failure("Document too big. Detached.")
        this.state = new State(newEditState, "detached")
      } else if ((this.state.comm == "poll" || action.requestDone) && (sendable = this.sendable(newEditState))) {
        this.closeRequest()
        this.state = new State(newEditState, "send")
        this.send(newEditState, sendable)
      } else if (action.requestDone) {
        this.state = new State(newEditState, "poll")
        this.poll()
      } else {
        this.state = new State(newEditState, this.state.comm)
      }
    }

    // Sync the editor with this.state.edit
    if (this.state.edit) {
      if (this.view)
        this.view.updateState(this.state.edit)
      else
        this.view = new MenuBarEditorView(document.querySelector("#editor"), {
          state: this.state.edit,
          dispatchTransaction: transaction => this.dispatch({type: "transaction", transaction}),
          menuContent: menu.fullMenu
        })
        window.view = this.view.editor
    } else if (this.view) {
      this.view.destroy()
      this.view = null
      window.view = undefined
    }


    // TRACKING CODE - BY Abhinav 7feb2017
      this.renderCommits(this.state.edit, this.dispatch)
  }

  // Load the document from the server and start up
  start() {
    this.run(GET(this.url)).then(data => {
      data = JSON.parse(data)
      this.report.success()
      this.backOff = 0
      this.dispatch({type: "loaded",
                     doc: schema.nodeFromJSON(data.doc),
                     version: data.version,
                     users: data.users,
                     comments: {version: data.commentVersion, comments: data.comments}})



        // BEGIN: TRACKING CODE - BY Abhinav 7feb2017
        const tr = this.state.edit.tr.insertText("Type something, and then commit it.")
        this.dispatch({type: "transaction", transaction: tr})
        const tr1 = this.state.edit.tr.setMeta(trackPlugin, "Initial commit")
        this.dispatch({type: "transaction", transaction: tr1})

        document.querySelector("#commit").addEventListener("submit", e => {
            e.preventDefault()
            this.doCommit(e.target.elements.message.value || "Unnamed")
            e.target.elements.message.value = ""
            // connection.view.editor.focus()
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
            let commitID = findInBlameMap(this.state.edit.selection.head, connection.state.edit)
            let commit = commitID != null && trackPlugin.getState(this.state.edit).commits[commitID]
            let node = crel("div", {class: "blame-info"},
                commitID != null ? ["It was: ", crel("strong", null, commit ? commit.message : "Uncommitted")]
                    : "No commit found")
            node.style.right = (document.body.clientWidth - pos.right) + "px"
            node.style.top = (pos.bottom + 2) + "px"
            document.body.appendChild(node)
            setTimeout(() => document.body.removeChild(node), 2000)
        })
        // END: TRACKING CODE - BY Abhinav 7feb2017


    }, err => {
      this.report.failure(err)
    })
  }

  // Send a request for events that have happened since the version
  // of the document that the client knows about. This request waits
  // for a new version of the document to be created if the client
  // is already up-to-date.
  poll() {
    let query = "version=" + getVersion(this.state.edit) + "&commentVersion=" + commentPlugin.getState(this.state.edit).version
    this.run(GET(this.url + "/events?" + query)).then(data => {
      this.report.success()
      data = JSON.parse(data)
      this.backOff = 0
      if (data.steps && (data.steps.length || data.comment.length)) {
        let tr = receiveTransaction(this.state.edit, data.steps.map(j => Step.fromJSON(schema, j)), data.clientIDs)
        tr.setMeta(commentPlugin, {type: "receive", version: data.commentVersion, events: data.comment, sent: 0})
        this.dispatch({type: "transaction", transaction: tr, requestDone: true})
      } else {
        this.poll()
      }
      info.users.textContent = userString(data.users)
    }, err => {
      if (err.status == 410 || badVersion(err)) {
        // Too far behind. Revert to server state
        report.failure(err)
        this.dispatch({type: "restart"})
      } else if (err) {
        this.dispatch({type: "recover", error: err})
      }
    })
  }

  sendable(editState) {
    let steps = sendableSteps(editState)
    let comments = commentPlugin.getState(editState).unsentEvents()
    if (steps || comments.length) return {steps, comments}
  }

  // Send the given steps to the server
  send(editState, {steps, comments}) {
    let json = JSON.stringify({version: getVersion(editState),
                               steps: steps ? steps.steps.map(s => s.toJSON()) : [],
                               clientID: steps ? steps.clientID : 0,
                               comment: comments || []})
    this.run(POST(this.url + "/events", json, "application/json")).then(data => {
      this.report.success()
      this.backOff = 0
      let tr = steps
          ? receiveTransaction(this.state.edit, steps.steps, repeat(steps.clientID, steps.steps.length))
          : this.state.edit.tr
      tr.setMeta(commentPlugin, {type: "receive", version: JSON.parse(data).commentVersion, events: [], sent: comments.length})
      this.dispatch({type: "transaction", transaction: tr, requestDone: true})
    }, err => {
      if (err.status == 409) {
        // The client's document conflicts with the server's version.
        // Poll for changes and then try again.
        this.backOff = 0
        this.dispatch({type: "poll"})
      } else if (badVersion(err)) {
        this.report.failure(err)
        this.dispatch({type: "restart"})
      } else {
        this.dispatch({type: "recover", error: err})
      }
    })
  }

  // Try to recover from an error
  recover(err) {
    let newBackOff = this.backOff ? Math.min(this.backOff * 2, 6e4) : 200
    if (newBackOff > 1000 && this.backOff < 1000) this.report.delay(err)
    this.backOff = newBackOff
    setTimeout(() => {
      if (this.state.comm == "recover") this.dispatch({type: "retry", requestDone: true})
    }, this.backOff)
  }

  closeRequest() {
    if (this.request) {
      this.request.abort()
      this.request = null
    }
  }

  run(request) {
    return this.request = request
  }

  close() {
    this.closeRequest()
    if (this.view) {
      document.querySelector("#editor").removeChild(this.view.wrapper)
      this.view = null
      window.view = undefined
    }
  }



    // BEGIN: TRACKING CODE - BY Abhinav 7feb2017
    revertCommit(commit) {
        let tState = trackPlugin.getState(this.state.edit)
        let found = tState.commits.indexOf(commit)
        if (found == -1) return

        if (tState.uncommittedSteps.length) return alert("Commit your changes first!")

        let remap = new Mapping(tState.commits.slice(found).reduce((maps, c) => maps.concat(c.maps), []))
        let tr = this.state.edit.tr
        for (let i = commit.steps.length - 1; i >= 0; i--) {
            let remapped = commit.steps[i].map(remap.slice(i + 1))
            let result = remapped && tr.maybeStep(remapped)
            if (result && result.doc) remap.appendMap(remapped.getMap(), i)
        }
        if (tr.docChanged) {
            const trans = tr.setMeta(trackPlugin, `Revert '${commit.message}'`)
            this.dispatch({type: "transaction", transaction: trans})
        }
    }

    renderCommits(state, dispatch) {
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
            node.lastChild.addEventListener("click", () => this.revertCommit(commit))
            node.addEventListener("mouseover", e => {
                if (!node.contains(e.relatedTarget)) {
                    const tr = state.tr.setMeta(highlightPlugin, {add: commit})
                    this.dispatch({type: "transaction", transaction: tr})
                }
            })
            node.addEventListener("mouseout", e => {
                if (!node.contains(e.relatedTarget)) {
                    const tr = state.tr.setMeta(highlightPlugin, {clear: commit})
                    this.dispatch({type: "transaction", transaction: tr})
                }
            })
            out.appendChild(node)
        })
    }

    doCommit(message) {
        const tr = this.state.edit.tr.setMeta(trackPlugin, message)
        this.dispatch({type: "transaction", transaction: tr})
    }
    // END: TRACKING CODE - BY Abhinav 7feb2017


}

function repeat(val, n) {
  let result = []
  for (let i = 0; i < n; i++) result.push(val)
  return result
}

const annotationMenuItem = new MenuItem({
  title: "Add an annotation",
  run: addAnnotation,
  select: state => addAnnotation(state),
  icon: annotationIcon
})
let menu = buildMenuItems(schema)
menu.fullMenu[0].push(annotationMenuItem)

let info = {
  name: document.querySelector("#docname"),
  users: document.querySelector("#users")
}
document.querySelector("#changedoc").addEventListener("click", e => {
  GET("/docs/").then(data => showDocList(e.target, JSON.parse(data)),
                     err => report.failure(err))
})

function userString(n) {
  if (n == null) n = 1
  return "(" + n + " user" + (n == 1 ? "" : "s") + ")"
}

let docList
function showDocList(node, list) {
  if (docList) docList.parentNode.removeChild(docList)

  let ul = docList = document.body.appendChild(crel("ul", {class: "doclist"}))
  list.forEach(doc => {
    ul.appendChild(crel("li", {"data-name": doc.id},
                        doc.id + " " + userString(doc.users)))
  })
  ul.appendChild(crel("li", {"data-new": "true", style: "border-top: 1px solid silver; margin-top: 2px"},
                      "Create a new document"))

  let rect = node.getBoundingClientRect()
  ul.style.top = (rect.bottom + 10 + pageYOffset - ul.offsetHeight) + "px"
  ul.style.left = (rect.left - 5 + pageXOffset) + "px"

  ul.addEventListener("click", e => {
    if (e.target.nodeName == "LI") {
      ul.parentNode.removeChild(ul)
      docList = null
      if (e.target.hasAttribute("data-name"))
        location.hash = "#edit-" + encodeURIComponent(e.target.getAttribute("data-name"))
      else
        newDocument()
    }
  })
}
document.addEventListener("click", () => {
  if (docList) {
    docList.parentNode.removeChild(docList)
    docList = null
  }
})

function newDocument() {
  let name = prompt("Name the new document", "")
  if (name)
    location.hash = "#edit-" + encodeURIComponent(name)
}

let connection = null

function connectFromHash() {
  let isID = /^#edit-(.+)/.exec(location.hash)
  if (isID) {
    if (connection) connection.close()
    info.name.textContent = decodeURIComponent(isID[1])
    connection = window.connection = new EditorConnection(report, "/docs/" + isID[1])
    connection.request.then(() => connection.view.editor.focus())
    return true
  }
}

addEventListener("hashchange", connectFromHash)
connectFromHash() || (location.hash = "#edit-Example")






// TRACK SETUP

// let state = EditorState.create({
//   schema,
//   plugins: exampleSetup({schema}).concat(trackPlugin, highlightPlugin)
// }), view

let lastRendered = null

// function dispatch(tr) {
//   // state = connection.state.edit.apply(tr)
//   // connection.view.updateState(connection.state.edit)
//   // setDisabled(connection.state.edit)
//   // renderCommits(connection.state.edit, dispatch)
// }

// view = new MenuBarEditorView(document.querySelector("#editor"), {state, dispatchTransaction: dispatch})
// window.view = view.editor

// setTimeout(() => {
//   connection.dispatch(connection.state.edit.tr.insertText("Type something, and then commit it."))
//     connection.dispatch(connection.state.edit.tr.setMeta(trackPlugin, "Initial commit"))
// }, 50)


function setDisabled(state) {
  let input = document.querySelector("#message")
  let button = document.querySelector("#commitbutton")
  input.disabled = button.disabled = trackPlugin.getState(state).uncommittedSteps.length == 0
}

// function doCommit(message) {
//     connection.dispatch(connection.state.edit.tr.setMeta(trackPlugin, message))
// }

// function renderCommits(state, dispatch) {
//   let curState = trackPlugin.getState(state)
//   if (lastRendered == curState) return
//   lastRendered = curState
//
//   let out = document.querySelector("#commits")
//   out.textContent = ""
//   let commits = curState.commits
//   commits.forEach(commit => {
//     let node = crel("div", {class: "commit"},
//         crel("span", {class: "commit-time"},
//             commit.time.getHours() + ":" + (commit.time.getMinutes() < 10 ? "0" : "")
//             + commit.time.getMinutes()),
//         "\u00a0 " + commit.message + "\u00a0 ",
//         crel("button", {class: "commit-revert"}, "revert"))
//     node.lastChild.addEventListener("click", () => revertCommit(commit))
//     node.addEventListener("mouseover", e => {
//       if (!node.contains(e.relatedTarget))
//         dispatch(state.tr.setMeta(highlightPlugin, {add: commit}))
//     })
//     node.addEventListener("mouseout", e => {
//       if (!node.contains(e.relatedTarget))
//         dispatch(state.tr.setMeta(highlightPlugin, {clear: commit}))
//     })
//     out.appendChild(node)
//   })
// }

// function revertCommit(commit) {
//   let tState = trackPlugin.getState(connection.state.edit)
//   let found = tState.commits.indexOf(commit)
//   if (found == -1) return
//
//   if (tState.uncommittedSteps.length) return alert("Commit your changes first!")
//
//   let remap = new Mapping(tState.commits.slice(found).reduce((maps, c) => maps.concat(c.maps), []))
//   let tr = state.tr
//   for (let i = commit.steps.length - 1; i >= 0; i--) {
//     let remapped = commit.steps[i].map(remap.slice(i + 1))
//     let result = remapped && tr.maybeStep(remapped)
//     if (result && result.doc) remap.appendMap(remapped.getMap(), i)
//   }
//   if (tr.docChanged) {
//       connection.dispatch(tr.setMeta(trackPlugin, `Revert '${commit.message}'`))
//   }
// }

// document.querySelector("#commit").addEventListener("submit", e => {
//   e.preventDefault()
//   doCommit(e.target.elements.message.value || "Unnamed")
//   e.target.elements.message.value = ""
//   // connection.view.editor.focus()
// })
//
// function findInBlameMap(pos, state) {
//   let map = trackPlugin.getState(state).blameMap
//   for (let i = 0; i < map.length; i++)
//     if (map[i].to >= pos && map[i].commit != null)
//       return map[i].commit
// }
//
// document.querySelector("#blame").addEventListener("mousedown", e => {
//   e.preventDefault()
//   let pos = e.target.getBoundingClientRect()
//   let commitID = findInBlameMap(connection.state.edit.selection.head, connection.state.edit)
//   let commit = commitID != null && trackPlugin.getState(connection.state.edit).commits[commitID]
//   let node = crel("div", {class: "blame-info"},
//       commitID != null ? ["It was: ", crel("strong", null, commit ? commit.message : "Uncommitted")]
//           : "No commit found")
//   node.style.right = (document.body.clientWidth - pos.right) + "px"
//   node.style.top = (pos.bottom + 2) + "px"
//   document.body.appendChild(node)
//   setTimeout(() => document.body.removeChild(node), 2000)
// })
