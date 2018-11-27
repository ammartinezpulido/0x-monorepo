import { ContractAddresses } from '@0x/contract-addresses';
import { OrderState } from '@0x/types';
import { BigNumber, logUtils } from '@0x/utils';
import { Provider } from 'ethereum-types';
import * as http from 'http';
import * as WebSocket from 'websocket';

import { OnOrderStateChangeCallback, OrderWatcherConfig } from '../types';

import { OrderWatcher } from './order_watcher';

const HTTP_PORT = 8080;

interface WebSocketRequestData {
    action: string;
    params: any;
}

interface WebSocketResponseData {
    action: string;
    success: number;
    result: any;
}

export class OrderWatcherWebSocketServer {
    public httpServer: http.Server;
    public readonly _orderWatcher: OrderWatcher;
    private readonly _connectionStore: Set<WebSocket.connection>;
    private readonly _wsServer: WebSocket.server;
    /**
     * Instantiate a new web socket server which provides OrderWatcher functionality
     *  @param provider Web3 provider to use for JSON RPC calls (for OrderWatcher)
     *  @param networkId NetworkId to watch orders on (for OrderWatcher)
     *  @param contractAddresses Optional contract addresses. Defaults to known
     *  addresses based on networkId (for OrderWatcher)
     *  @param partialConfig Optional configurations (for OrderWatcher)
     */
    constructor(
        provider: Provider,
        networkId: number,
        contractAddresses?: ContractAddresses,
        partialConfig?: Partial<OrderWatcherConfig>,
    ) {
        this._orderWatcher = new OrderWatcher(
            provider, networkId, contractAddresses, partialConfig);
        this._connectionStore = new Set();

        this.httpServer = http.createServer((request, response) => {
            response.writeHead(404);
            response.end();
        });

        this._wsServer = new WebSocket.server({
            httpServer: this.httpServer,
            autoAcceptConnections: false,
        });

        this._wsServer.on('request', (request: any) => {
            logUtils.log(`${new Date()} [Server] Connection from origin ${request.origin}.`);

            const connection: WebSocket.connection = request.accept(null, request.origin);
            this._connectionStore.add(connection);
            connection.on('message', (message: any) => {
                if (message.type !== 'utf8') {
                    throw new Error('[Server] This WebSocket server only accepts string-type messages.');
                }
                const requestData: WebSocketRequestData = JSON.parse(message.utf8Data);
                const responseData = this._routeRequest(connection, requestData);
                logUtils.log(`${new Date()} [Server] OrderWatcher output: ${JSON.stringify(responseData)}`);
                connection.sendUTF(JSON.stringify(responseData));
            });

            connection.on('close', (message: any) => {
                this._connectionStore.delete(connection);
                logUtils.log(`${new Date()} [Server] Client ${message.remoteAddress} disconnected.`);
            });
        });

        const _broadcastCallback: OnOrderStateChangeCallback = (err, orderState) => {
            this._connectionStore.forEach((connection: WebSocket.connection) => {
                const responseData: WebSocketResponseData = {
                    action: 'orderWatcherUpdate',
                    success: 1,
                    result: orderState || err,
                };
                connection.sendUTF(JSON.stringify(responseData));
            });
        };
        // Have the WebSocket server subscribe to the OrderWatcher to receive
        // updates which can be broadcasted to the connected clients.
        this._orderWatcher.subscribe(_broadcastCallback);
    }

    public listen(): void {
        this.httpServer.listen(HTTP_PORT, () => {
            logUtils.log(`${new Date()} [Server] Listening on port ${HTTP_PORT}`);
        });
    }

    public close(): void {
        this.httpServer.close();
    }

    private _routeRequest(
        connection: WebSocket.connection,
        requestData: WebSocketRequestData,
    ): WebSocketResponseData {

        const responseData: WebSocketResponseData = {
            action: requestData.action,
            success: 0,
            result: undefined,
        };

        try {
            logUtils.log(`${new Date()} [Server] Request received: ${requestData.action}`);
            switch (requestData.action) {
                case 'addOrderAsync': {
                    // how to handle async here?
                    this._wrapperAddOrderAsync(requestData);
                    break;
                }
                case 'removeOrder': {
                    this._orderWatcher.removeOrder(requestData.params.orderHash);
                    break;
                }
                case 'getStats': {
                    responseData.result = this._orderWatcher.getStats();
                    break;
                }
                default:
                    throw new Error(`[Server] Invalid request action: ${requestData.action}`);
            }
            responseData.success = 1;
            return responseData;
        } catch {
            return responseData;
        }
    }

    private async _wrapperAddOrderAsync(requestData: WebSocketRequestData): Promise<void> {
        // Recover types lost when the payload is stringified.
        const signedOrder = requestData.params.signedOrder;
        const bigNumberFields = [
            'salt',
            'makerFee',
            'takerFee',
            'makerAssetAmount',
            'takerAssetAmount',
            'expirationTimeSeconds',
        ];
        for (const field of bigNumberFields) {
            signedOrder[field] = new BigNumber(signedOrder[field]);
        }
        return this._orderWatcher.addOrderAsync(signedOrder);
    }
}
