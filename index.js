"use strict";
const libc = require("./lib/c.js");
const net = require("net");
const tls = require("tls");
const events = require("events");
const assert = require("./lib/assert.js");
const typed = require("./lib/typed.js");

class Connection extends events.EventEmitter {
	constructor (socket, nanos2date, flipTables, emptyChar2null, long2number) {
		super();
		this.socket = socket;
		this.nanos2date = nanos2date;
		this.flipTables = flipTables;
		this.emptyChar2null = emptyChar2null;
		this.long2number = long2number;
		this.nextRequestNo = 1;
		this.nextResponseNo = 1;
		this.socket.on("end", () => this.emit("end"));
		this.socket.on("timeout", () => this.emit("timeout"));
		this.socket.on("error", (err) => this.emit("error", err));
		this.socket.on("close", (had_error) => this.emit("close", had_error));
	}

	listen() {
		this.chunk = new Buffer(0);
		this.socket.on("data", (inbuffer) => {
			let buffer,
				length, // current msg length
				o, // deserialized object
				err, // deserialize error
				responseNo;

			if (this.chunk.length !== 0) {
				buffer = new Buffer(this.chunk.length + inbuffer.length);
				this.chunk.copy(buffer);
				inbuffer.copy(buffer, this.chunk.length);
			} else {
				buffer = inbuffer;
			}
			while (buffer.length >= 8) {
				length = buffer.readUInt32LE(4);
				if (buffer.length >= length) {
					try {
						o = libc.deserialize(buffer, this.nanos2date, this.flipTables, this.emptyChar2null, this.long2number);
						err = undefined;
					} catch (e) {
						o = null;
						err = e;
					}
					if (buffer.readUInt8(1) === 2) { // MsgType: 2 := response
						responseNo = this.nextResponseNo;
						this.nextResponseNo += 1;
						this.emit("response:" + responseNo, err, o);
					} else {
						if (err === undefined && Array.isArray(o) && o[0] === "upd") {
							this.emit(o);
						} else {
							responseNo = this.nextResponseNo;
							this.nextResponseNo += 1;
							this.emit("response:" + responseNo, err, o);
						}
					}
					if (buffer.length > length) {
						buffer = buffer.slice(length);
					} else {
						buffer = new Buffer(0);
					}
				} else {
					break;
				}
			}

			this.chunk = buffer;
		});
	}

	auth(auth, cb) {
		const n = Buffer.byteLength(auth, "ascii"),
			b = new Buffer(n + 2);
		b.write(auth, 0, n, "ascii"); // auth (username:password)
		b.writeUInt8(0x3, n); // capability byte (compression, timestamp, timespan) http://code.kx.com/wiki/Reference/ipcprotocol#Handshake
		b.writeUInt8(0x0, n+1); // zero terminated
		this.socket.write(b);
		this.socket.once("data", (buffer) => {
			if (buffer.length === 1) {
				if (buffer[0] >= 1) { // capability byte must support at least (compression, timestamp, timespan) http://code.kx.com/wiki/Reference/ipcprotocol#Handshake
					this.listen();
					cb();
				} else {
					cb(new Error("Invalid capability byte from server"));
				}
			} else {
				cb(new Error("Invalid auth response from server"));
			}
		});
	}

	k(s, cb) {
		cb = arguments[arguments.length - 1];
		assert.func(cb, "cb");
		let payload,
			b,
			requestNo = this.nextRequestNo;
		this.nextRequestNo += 1;
		if (arguments.length === 1) {
			// Listen for async responses
			this.once("response:" + requestNo, function(err, o) {
				cb(err, o);
			});
		} else {
			assert.string(s, "s");
			if (arguments.length === 2) {
				payload = s;
			} else {
				payload = Array.prototype.slice.call(arguments, 0, arguments.length - 1);
			}
			b = libc.serialize(payload);
			b.writeUInt8(0x1, 1); // MsgType: 1 := sync
			this.socket.write(b, () => {
				this.once("response:" + requestNo, function(err, o) {
					cb(err, o);
				});
			});
		}
	}

	ks(s, cb) {
		assert.string(s, "s");
		cb = arguments[arguments.length - 1];
		assert.func(cb, "cb");
		let payload,
			b;
		if (arguments.length === 2) {
			payload = s;
		} else {
			payload = Array.prototype.slice.call(arguments, 0, arguments.length - 1);
		}
		b = libc.serialize(payload);
		this.socket.write(b, function() {
			cb();
		});
	}

	close(cb) {
		assert.optionalFunc(cb, "cb");
		this.socket.once("close", function() {
			if (cb) {
				cb();
			}
		});
		this.socket.end();
	}
}


function connect(params, cb) {
	let auth,
		errorcb,
		closecb,
		socket,
		error = false,
		close = false;
	if (typeof params !== "object") {
		params = {};
		if (arguments.length === 2) {
			params.unixSocket = arguments[0];
			cb = arguments[1];
		} else if (arguments.length === 3) {
			params.host = arguments[0];
			params.port = arguments[1];
			cb = arguments[2];
		} else if (arguments.length === 5) {
			params.host = arguments[0];
			params.port = arguments[1];
			params.user = arguments[2];
			params.password = arguments[3];
			cb = arguments[4];
		} else {
			throw new Error("only two, three or five arguments allowed");
		}
	}
	assert.object(params, "params");
	assert.optionalString(params.host, "params.host");
	assert.optionalNumber(params.port, "params.port");
	assert.optionalString(params.user, "params.user");
	assert.optionalString(params.password, "password");
	assert.optionalBool(params.socketNoDelay, "params.socketNoDelay");
	assert.optionalNumber(params.socketTimeout, "params.socketTimeout");
	assert.optionalBool(params.nanos2date, "params.nanos2date");
	assert.optionalBool(params.flipTables, "params.flipTables");
	assert.optionalBool(params.emptyChar2null, "params.emptyChar2null");
	assert.optionalBool(params.long2number, "params.long2number");
	assert.optionalString(params.unixSocket, "params.unixSocket");
	assert.optionalBool(params.useTLS, "params.useTLS");
	if (params.user !== undefined) {
		assert.string(params.password, "password");
		auth = params.user + ":" + params.password;
	} else {
		auth = "anonymous";
	}
	assert.func(cb, "cb");
	errorcb = function(err) {
		error = true;
		cb(err);
	};
	closecb = function() {
		close = true;
		cb(new Error("Connection closes (wrong auth?)"));
	};
	const socketArgs = [];
	if (params.unixSocket) {
		socketArgs.push(params.unixSocket);
	}
	else {
		socketArgs.push(params.port, params.host);
	}
	socketArgs.push(function() {
		socket.removeListener("error", errorcb);
		if (error === false) {
			socket.once("close", closecb);
			const con = new Connection(socket, params.nanos2date, params.flipTables, params.emptyChar2null, params.long2number);
			con.once("error", function(err) {
				socket.removeListener("close", closecb);
				cb(err);
			});
			con.auth(auth, function() {
				socket.removeListener("close", closecb);
				if (close === false) {
					cb(undefined, con);
				}
			});
		}
	});

	if (params.useTLS) {
		socket = tls.connect.apply(null, socketArgs);
	} else {
		socket = net.connect.apply(null, socketArgs);
	}

	if (params.socketTimeout !== undefined) {
		socket.setTimeout(params.socketTimeout);
	}
	if (params.socketNoDelay !== undefined) {
		socket.setNoDelay(params.socketNoDelay);
	}
	socket.once("error", errorcb);
}
exports.connect = connect;

// export typed API
Object.keys(typed).forEach(function(k) {
	if (/^[a-z]*$/.test(k[0])) {
		exports[k] = typed[k];
	}
});
