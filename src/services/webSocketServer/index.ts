import EventEmitter from "events";
import { IncomingMessage } from "http";
import url from "url";
import WebSocketLib from "ws";
import { IConfig } from "../../config";
import { Errors, MessageType } from "../../enums";
import { Client, IClient } from "../../models/client";
import { IRealm } from "../../models/realm";
import { MyWebSocket } from "./webSocket";

export interface IWebSocketServer extends EventEmitter {
  readonly path: string;
}

interface IAuthParams {
  id?: string;
  token?: string;
  key?: string;
}

type CustomConfig = Pick<IConfig, 'path' | 'key' | 'concurrent_limit'>;

const WS_PATH = 'peerjs';

export class WebSocketServer extends EventEmitter implements IWebSocketServer {

  public readonly path: string;
  private readonly realm: IRealm;
  private readonly config: CustomConfig;
  private readonly onClose?: (client: IClient) => void; // a callback to emit close event to application level
  public readonly socketServer: WebSocketLib.Server;

    constructor({ server, realm, config, onClose }: { server: any; realm: IRealm; config: CustomConfig; onClose?: (client: IClient) => void; }) {
    super();

    this.setMaxListeners(0);

    this.realm = realm;
    this.config = config;
    this.onClose = onClose;

    const path = this.config.path;
    this.path = `${path}${path.endsWith('/') ? "" : "/"}${WS_PATH}`;

    this.socketServer = new WebSocketLib.Server({ path: this.path, server });

    this.socketServer.on("connection", (socket: MyWebSocket, req) => this._onSocketConnection(socket, req));
    this.socketServer.on("error", (error: Error) => this._onSocketError(error));
  }

  private _onSocketConnection(socket: MyWebSocket, req: IncomingMessage): void {
    const { query = {} } = url.parse(req.url ?? '', true);

    const { id, token, key }: IAuthParams = query;

    if (!id || !token || !key) {
      return this._sendErrorAndClose(socket, Errors.INVALID_WS_PARAMETERS);
    }

    if (key !== this.config.key) {
      return this._sendErrorAndClose(socket, Errors.INVALID_KEY);
    }

    const client = this.realm.getClientById(id);

    let finalToken = token; // we need to regenerate token when reconnect below
    if (client) {   // client with same Id already exists
      // A magic token indicates it's to reconnect - though it's a different peer from peerjs point of view
      // (we didn't use the built-in peer.reconnect)
      if (token === '__RECONNECT__') {
        // close the existing client, and emit close event
        try {
            client.getSocket()?.close();
        } finally {
            this.realm.clearMessageQueue(id);
            this.realm.removeClientById(id);

            client.setSocket(null);

            this.onClose?.(client);
        }
        // regenerate a random token and abandon the magic one (the same algorithm as used in peerjs client lib)
        finalToken = Math.random().toString(36).substr(2);  
      } else {  // normal path of peerjs
        if (token !== client.getToken()) {
            // ID-taken, invalid token
            socket.send(JSON.stringify({
                type: MessageType.ID_TAKEN,
                payload: { msg: "ID is taken" }
            }));

            return socket.close();
        }

        return this._configureWS(socket, client);
      }
    }

    this._registerClient({ socket, id, token: finalToken });
  }

  private _onSocketError(error: Error): void {
    // handle error
    this.emit("error", error);
  }

  private _registerClient({ socket, id, token }:
    {
      socket: MyWebSocket;
      id: string;
      token: string;
    }): void {
    // Check concurrent limit
    const clientsCount = this.realm.getClientsIds().length;

    if (clientsCount >= this.config.concurrent_limit) {
      return this._sendErrorAndClose(socket, Errors.CONNECTION_LIMIT_EXCEED);
    }

    const newClient: IClient = new Client({ id, token });
    this.realm.setClient(newClient, id);
    socket.send(JSON.stringify({ type: MessageType.OPEN }));

    this._configureWS(socket, newClient);
  }

  private _configureWS(socket: MyWebSocket, client: IClient): void {
    client.setSocket(socket);

    // Cleanup after a socket closes.
    socket.on("close", () => {
      if (client.getSocket() === socket) {
        this.realm.removeClientById(client.getId());
        this.emit("close", client);
      }
    });

    // Handle messages from peers.
    socket.on("message", (data: WebSocketLib.Data) => {
      try {
        const message = JSON.parse(data as string);

        message.src = client.getId();

        this.emit("message", client, message);
      } catch (e) {
        this.emit("error", e);
      }
    });

    this.emit("connection", client);
  }

  private _sendErrorAndClose(socket: MyWebSocket, msg: Errors): void {
    socket.send(
      JSON.stringify({
        type: MessageType.ERROR,
        payload: { msg }
      })
    );

    socket.close();
  }
}
