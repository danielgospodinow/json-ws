/**
 * Implementation of an HTTP/REST transport for the JSON-WS module.
 */

'use strict';

const jsonrpc = require('./json-rpc');
const Transport = require('./transport').Transport;

function param(req, name, defaultValue) {
	const params = req.params || {};
	const body = req.body || {};
	const query = req.query || {};
	if (params[name] !== null && params[name] !== undefined && params.hasOwnProperty(name)) {
		return params[name];
	}
	if (body[name] !== null && body[name] !== undefined) {
		return body[name];
	}
	if (query[name] !== null && query[name] !== undefined) {
		return query[name];
	}
	return defaultValue;
}

class RestTransport extends Transport {
	constructor(httpServer, expressApp) {
		super();
		this.srv = httpServer;
		this.app = expressApp;
		this.name = 'HTTP';
		const sockets = this.sockets = [];
		let id = 0;
		this.srv.setMaxListeners(0);
		this.srv.on('connection', (socket) => {
			socket.setMaxListeners(0);
			const connectionCtx = {socket: socket};
			connectionCtx.objectId = '!#ConnectionCtx:' + (id++);
			connectionCtx.toString = function () {
				return this.objectId;
			};
			this.onConnect(connectionCtx);

			sockets.push(socket);
			socket.on('close', () => {
				this.onDisconnect(connectionCtx);
				sockets.splice(sockets.indexOf(socket), 1);
			});
		});
	}

	close() {
		if (this.srv) {
			try {
				this.srv.close();
				for (const socket of this.sockets) {
					socket.destroy();
				}
				this.srv = null;
			} catch (e) {//eslint-ignore-line no-empty-blocks
			}
		}
	}

	// HTTP-specific sendMessage
	sendMessage(msg, context, format) {
		const res = context.http.response;
		res.set('Access-Control-Allow-Origin', '*');
		let isSent = false;
		try {
			if (msg.error) {
				res.set('Content-Type', 'application/json');
				res.status(500).send(JSON.stringify(msg));
				isSent = true;
			} else if (msg.id !== undefined && msg.id !== null) {
				// For now, assume that no format means JSON
				// otherwise simply dump the message as-is into the response stream
				// This can be extended with custom formatters if required
				const messageData = format || Buffer.isBuffer(msg.result) ? msg.result : JSON.stringify(msg);
				res.set('Content-Type', format || (Buffer.isBuffer(messageData) ? 'application/octet-stream' : 'application/json'));
				res.send(messageData);
				isSent = true;
			}
		} finally {
			if (!isSent) {
				res.end();
			}
		}
	}

	// Override the attach method
	// Set up Express routes
	attach(api, path) {
		Transport.prototype.attach.call(this, api, path);
		const restHandler = (req, res) => {
			const methodName = req.params.methodName || param(req, 'method') || null;
			const methodInfo = this.api.methodMap[methodName];

			const json = jsonrpc.jsonrpc({
				method: methodName
			});

			const id = param(req, 'id');
			if (id !== undefined && id !== null) {
				json.id = id;
			} else if (!methodInfo || methodInfo.returns || methodInfo.async) {
				// auto-assign a message ID if the method has a declared return type (or is declared as async)
				// and no ID was given on input. Also, if the method was NOT found, assign an ID so
				// the error is always returned to the clients
				json.id = methodName;
			}

			const params = param(req, 'params');
			if (params !== undefined) {
				json.params = params;
				if (typeof json.params === 'string') {
					try {
						json.params = JSON.parse(json.params);
					} catch (unnamedJsonParseErr) { //eslint-ignore-line no-empty-blocks
					}
				}
			} else if (methodInfo && methodInfo.params) {
				json.params = {};
				for (let i = 0; i < methodInfo.params.length; i++) {
					const parName = methodInfo.params[i].name;
					const paramValue = param(req, parName);
					if (typeof paramValue !== 'undefined') {
						json.params[parName] = paramValue;
						if (typeof json.params[parName] === 'string') {
							try {
								json.params[parName] = JSON.parse(json.params[parName]);
							} catch (namedJsonParseErr) { //eslint-ignore-line no-empty-blocks
							}
						}
					}
				}
				if (Object.keys(json.params).length === 0) {
					delete json.params;
				}
			}

			this.handleMessage(json, {
				http: {
					request: req,
					response: res
				}
			});
		};
		this.app.post(this.api.path, restHandler);
		this.app.all(`${this.api.path}/:methodName`, restHandler);
	}
}

module.exports = RestTransport;