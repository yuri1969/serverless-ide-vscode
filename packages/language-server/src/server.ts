"use strict"

import {
	CompletionList,
	createConnection,
	IConnection,
	InitializeParams,
	InitializeResult,
	Position,
	ProposedFeatures,
	TextDocument,
	TextDocuments
} from "vscode-languageserver"
import { JSONSchema } from "./language-service/jsonSchema"

import path = require("path")
import { configure as configureHttpRequests } from "request-light"
import * as URL from "url"
import * as nls from "vscode-nls"
import {
	getLanguageService as getCustomLanguageService,
	LanguageSettings
} from "./language-service/languageService"
import { parse as parseYAML } from "./language-service/parser"
import {
	getLineOffsets,
	removeDuplicatesObj
} from "./language-service/utils/arrayUtils"
import {
	isCloudFormationTemplate,
	isSAMTemplate,
	isSupportedDocument
} from "./language-service/utils/document"
import URI from "./language-service/utils/uri"
nls.config(process.env.VSCODE_NLS_CONFIG as any)

// Create a connection for the server.
let connection: IConnection = null
if (process.argv.indexOf("--stdio") === -1) {
	connection = createConnection(ProposedFeatures.all)
} else {
	connection = createConnection()
}

// tslint:disable-next-line: no-console
console.log = connection.console.log.bind(connection.console)
// tslint:disable-next-line: no-console
console.error = connection.console.error.bind(connection.console)

// Create a simple text document manager. The text document manager
// supports full document sync only
const documents: TextDocuments = new TextDocuments()
// Make the text document manager listen on the connection
// for open, change and close text document events
documents.listen(connection)

let hasWorkspaceFolderCapability = false

// After the server has started the client sends an initilize request. The server receives
// in the passed params the rootPath of the workspace plus the client capabilities.
let capabilities
let workspaceRoot: URI
connection.onInitialize(
	(params: InitializeParams): InitializeResult => {
		capabilities = params.capabilities
		workspaceRoot = URI.parse(params.rootPath)

		hasWorkspaceFolderCapability =
			capabilities.workspace && !!capabilities.workspace.workspaceFolders
		return {
			capabilities: {
				textDocumentSync: documents.syncKind,
				completionProvider: { resolveProvider: true },
				hoverProvider: true,
				documentSymbolProvider: true,
				documentFormattingProvider: false
			}
		}
	}
)

const workspaceContext = {
	resolveRelativePath: (relativePath: string, resource: string) => {
		return URL.resolve(resource, relativePath)
	}
}

export const customLanguageService = getCustomLanguageService(
	workspaceContext,
	[]
)

// The settings interface describes the server relevant settings part
interface Settings {
	serverlessIDE: {
		validationProvider: "default" | "cfn-lint"
		cfnLint: {
			path: string
			appendRules: string[]
			ignoreRules: string[]
			overrideSpecPath: string
		}
		validate: boolean
		hover: boolean
		completion: boolean
	}
	http: {
		proxy: string
		proxyStrictSSL: boolean
	}
}

let schemaConfigurationSettings: Array<{
	url?: string
	schema?: JSONSchema
	documentMatch: (text: string) => boolean
}> = []
let yamlShouldValidate = true
let yamlShouldHover = true
let yamlShouldCompletion = true
const schemaStoreSettings = []
const customTags = [
	"!And",
	"!If",
	"!Not",
	"!Equals",
	"!Or",
	"!FindInMap",
	"!Base64",
	"!Cidr",
	"!Ref",
	"!Sub",
	"!GetAtt",
	"!GetAZs",
	"!ImportValue",
	"!Select",
	"!Split",
	"!Join"
]

connection.onDidChangeConfiguration(change => {
	const settings = change.settings as Settings
	configureHttpRequests(
		settings.http && settings.http.proxy,
		settings.http && settings.http.proxyStrictSSL
	)

	if (settings.serverlessIDE) {
		yamlShouldValidate = settings.serverlessIDE.validate
		yamlShouldHover = settings.serverlessIDE.hover
		yamlShouldCompletion = settings.serverlessIDE.completion
	}

	// add default schema
	schemaConfigurationSettings = [
		{
			url:
				"https://raw.githubusercontent.com/awslabs/goformation/master/schema/cloudformation.schema.json",
			documentMatch: isCloudFormationTemplate
		},
		{
			schema: require("@serverless-ide/sam-schema/schema.json"),
			documentMatch: isSAMTemplate
		}
	]

	updateConfiguration()
})

function updateConfiguration() {
	let languageSettings: LanguageSettings = {
		validate: yamlShouldValidate,
		hover: yamlShouldHover,
		completion: yamlShouldCompletion,
		schemas: [],
		customTags
	}
	if (schemaConfigurationSettings) {
		schemaConfigurationSettings.forEach(schema => {
			let uri = schema.url
			if (!uri && schema.schema) {
				uri = schema.schema.id
			}
			if (!uri) {
				uri = "vscode://schemas/custom/" + encodeURIComponent("*.yaml")
			}
			if (uri) {
				if (
					uri[0] === "." &&
					workspaceRoot &&
					!hasWorkspaceFolderCapability
				) {
					// workspace relative path
					uri = URI.file(
						path.normalize(path.join(workspaceRoot.fsPath, uri))
					).toString()
				}
				languageSettings = configureSchemas(
					uri,
					schema.documentMatch,
					schema.schema,
					languageSettings
				)
			}
		})
	}
	if (schemaStoreSettings) {
		languageSettings.schemas = languageSettings.schemas.concat(
			schemaStoreSettings
		)
	}
	customLanguageService.configure(languageSettings)

	// Revalidate any open text documents
	documents.all().forEach(triggerValidation)
}

function configureSchemas(
	uri: string,
	documentMatch: (text: string) => boolean,
	schema: JSONSchema,
	languageSettings: LanguageSettings
) {
	if (schema === null) {
		languageSettings.schemas.push({ uri, documentMatch })
	} else {
		languageSettings.schemas.push({
			uri,
			documentMatch,
			schema
		})
	}

	return languageSettings
}

documents.onDidChangeContent(change => {
	triggerValidation(change.document)
})

documents.onDidClose(event => {
	cleanPendingValidation(event.document)
	connection.sendDiagnostics({ uri: event.document.uri, diagnostics: [] })
})

const pendingValidationRequests: { [uri: string]: NodeJS.Timer } = {}
const validationDelayMs = 200

function cleanPendingValidation(textDocument: TextDocument): void {
	const request = pendingValidationRequests[textDocument.uri]
	if (request) {
		clearTimeout(request)
		delete pendingValidationRequests[textDocument.uri]
	}
}

function triggerValidation(textDocument: TextDocument): void {
	cleanPendingValidation(textDocument)
	pendingValidationRequests[textDocument.uri] = setTimeout(() => {
		delete pendingValidationRequests[textDocument.uri]
		validateTextDocument(textDocument)
	}, validationDelayMs)
}

function validateTextDocument(textDocument: TextDocument): void {
	if (!textDocument) {
		return
	}

	const text = textDocument.getText()

	if (text.length === 0) {
		connection.sendDiagnostics({ uri: textDocument.uri, diagnostics: [] })
		return
	}

	if (!isSupportedDocument(text)) {
		connection.sendDiagnostics({ uri: textDocument.uri, diagnostics: [] })
		return
	}

	const yamlDocument = parseYAML(text, customTags)
	customLanguageService
		.doValidation(textDocument, yamlDocument)
		.then(diagnosticResults => {
			const diagnostics = []

			diagnosticResults.forEach(diagnosticItem => {
				diagnosticItem.severity = 1 // Convert all warnings to errors
				diagnostics.push(diagnosticItem)
			})

			connection.sendDiagnostics({
				uri: textDocument.uri,
				diagnostics: removeDuplicatesObj(diagnostics)
			})
		})
}

connection.onDidChangeWatchedFiles(change => {
	// Monitored files have changed in VSCode
	let hasChanges = false
	change.changes.forEach(c => {
		if (customLanguageService.resetSchema(c.uri)) {
			hasChanges = true
		}
	})
	if (hasChanges) {
		documents.all().forEach(validateTextDocument)
	}
})

connection.onCompletion(textDocumentPosition => {
	const textDocument = documents.get(textDocumentPosition.textDocument.uri)

	const result: CompletionList = {
		items: [],
		isIncomplete: false
	}

	if (!textDocument) {
		return Promise.resolve(result)
	}

	const text = textDocument.getText()

	if (!isSupportedDocument(text)) {
		return Promise.resolve(void 0)
	}

	const completionFix = completionHelper(
		textDocument,
		textDocumentPosition.position
	)
	const newText = completionFix.newText
	const jsonDocument = parseYAML(newText)
	return customLanguageService.doComplete(
		textDocument,
		textDocumentPosition.position,
		jsonDocument
	)
})

function is_EOL(c) {
	return c === 0x0a /* LF */ || c === 0x0d /* CR */
}

function completionHelper(
	document: TextDocument,
	textDocumentPosition: Position
) {
	// Get the string we are looking at via a substring
	const linePos = textDocumentPosition.line
	const position = textDocumentPosition
	const lineOffset = getLineOffsets(document.getText())
	const start = lineOffset[linePos] // Start of where the autocompletion is happening
	let end = 0 // End of where the autocompletion is happening
	if (lineOffset[linePos + 1]) {
		end = lineOffset[linePos + 1]
	} else {
		end = document.getText().length
	}

	while (end - 1 >= 0 && is_EOL(document.getText().charCodeAt(end - 1))) {
		end--
	}

	const textLine = document.getText().substring(start, end)

	// Check if the string we are looking at is a node
	if (textLine.indexOf(":") === -1) {
		// We need to add the ":" to load the nodes

		let newText = ""

		// This is for the empty line case
		const trimmedText = textLine.trim()
		if (
			trimmedText.length === 0 ||
			(trimmedText.length === 1 && trimmedText[0] === "-")
		) {
			// Add a temp node that is in the document but we don't use at all.
			newText =
				document.getText().substring(0, start + textLine.length) +
				(trimmedText[0] === "-" && !textLine.endsWith(" ") ? " " : "") +
				"holder:\r\n" +
				document
					.getText()
					.substr(
						lineOffset[linePos + 1] || document.getText().length
					)

			// For when missing semi colon case
		} else {
			// Add a semicolon to the end of the current line so we can validate the node
			newText =
				document.getText().substring(0, start + textLine.length) +
				":\r\n" +
				document
					.getText()
					.substr(
						lineOffset[linePos + 1] || document.getText().length
					)
		}

		return {
			newText,
			newPosition: textDocumentPosition
		}
	} else {
		// All the nodes are loaded
		position.character = position.character - 1
		return {
			newText: document.getText(),
			newPosition: position
		}
	}
}

connection.onCompletionResolve(completionItem => {
	return customLanguageService.doResolve(completionItem)
})

connection.onHover(textDocumentPositionParams => {
	const document = documents.get(textDocumentPositionParams.textDocument.uri)

	if (!document) {
		return Promise.resolve(void 0)
	}

	const text = document.getText()

	if (!isSupportedDocument(text)) {
		return Promise.resolve(void 0)
	}

	const jsonDocument = parseYAML(text)
	return customLanguageService.doHover(
		document,
		textDocumentPositionParams.position,
		jsonDocument
	)
})

connection.onDocumentSymbol(documentSymbolParams => {
	const document = documents.get(documentSymbolParams.textDocument.uri)

	if (!document) {
		return
	}

	const text = document.getText()

	if (!isSupportedDocument(text)) {
		return
	}

	const jsonDocument = parseYAML(text)
	return customLanguageService.findDocumentSymbols(document, jsonDocument)
})

connection.listen()
