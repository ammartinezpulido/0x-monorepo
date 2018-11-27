import { ContractWrappers } from '@0x/contract-wrappers';
import { tokenUtils } from '@0x/contract-wrappers/lib/test/utils/token_utils';
import { BlockchainLifecycle } from '@0x/dev-utils';
import { FillScenarios } from '@0x/fill-scenarios';
import { assetDataUtils, orderHashUtils } from '@0x/order-utils';
import {
    ExchangeContractErrs,
    OrderStateInvalid,
    OrderStateValid,
    SignedOrder,
} from '@0x/types';
import { BigNumber, logUtils } from '@0x/utils';
import { Web3Wrapper } from '@0x/web3-wrapper';
import * as chai from 'chai';
import 'mocha';
import * as WebSocket from 'websocket';

import { OrderWatcherWebSocketServer } from '../src/order_watcher/order_watcher_websocket';

import { chaiSetup } from './utils/chai_setup';
import { constants } from './utils/constants';
import { migrateOnceAsync } from './utils/migrate';
import { provider, web3Wrapper } from './utils/web3_wrapper';

chaiSetup.configure();
const expect = chai.expect;
const blockchainLifecycle = new BlockchainLifecycle(web3Wrapper);

interface WsMessage {
    data: string;
}

describe.only('OrderWatcherWebSocket', async () => {
    let contractWrappers: ContractWrappers;
    let wsServer: OrderWatcherWebSocketServer;
    let wsClient: WebSocket.w3cwebsocket;
    let wsClientTwo: WebSocket.w3cwebsocket;
    let fillScenarios: FillScenarios;
    let userAddresses: string[];
    let makerAssetData: string;
    let takerAssetData: string;
    let makerTokenAddress: string;
    let takerTokenAddress: string;
    let makerAddress: string;
    let takerAddress: string;
    let zrxTokenAddress: string;
    let signedOrder: SignedOrder;
    const decimals = constants.ZRX_DECIMALS;
    const fillableAmount = Web3Wrapper.toBaseUnitAmount(new BigNumber(5), decimals);
    // createFillableSignedOrderAsync is Promise-based, which forces us
    // to use Promises instead of the done() callbacks for tests.
    // onmessage handler must thus be wrapped as a Promise.
    const _onMessageAsync = async (client: WebSocket.w3cwebsocket) => new Promise<WsMessage>(resolve => {
        client.onmessage = (msg: WsMessage) => resolve(msg);
    });

    before(async () => {
        const orderWatcherConfig = {};
        const contractAddresses = await migrateOnceAsync();
        await blockchainLifecycle.startAsync();
        const networkId = constants.TESTRPC_NETWORK_ID;
        const config = {
            networkId,
            contractAddresses,
        };
        wsServer = new OrderWatcherWebSocketServer(provider, networkId, contractAddresses, orderWatcherConfig);
        wsServer.listen();

        contractWrappers = new ContractWrappers(provider, config);
        userAddresses = await web3Wrapper.getAvailableAddressesAsync();
        zrxTokenAddress = contractAddresses.zrxToken;
        [makerAddress, takerAddress] = userAddresses;
        [makerTokenAddress, takerTokenAddress] = tokenUtils.getDummyERC20TokenAddresses();
        [makerAssetData, takerAssetData] = [
            assetDataUtils.encodeERC20AssetData(makerTokenAddress),
            assetDataUtils.encodeERC20AssetData(takerTokenAddress),
        ];
        fillScenarios = new FillScenarios(
            provider,
            userAddresses,
            zrxTokenAddress,
            contractAddresses.exchange,
            contractAddresses.erc20Proxy,
            contractAddresses.erc721Proxy,
        );
    });
    after(async () => {
        await blockchainLifecycle.revertAsync();
        wsServer.close();
    });
    beforeEach(async () => {
        await blockchainLifecycle.startAsync();
        wsClient = new WebSocket.w3cwebsocket('ws://127.0.0.1:8080/');
        logUtils.log(`${new Date()} [Client] Connected.`);
    });
    afterEach(async () => {
        await blockchainLifecycle.revertAsync();
        wsClient.close();
        logUtils.log(`${new Date()} [Client] Closed.`);
    });

    it('responds to getStats requests correctly', (done: any) => {
        const payload = {
            action: 'getStats',
            params: {},
        };
        wsClient.onopen = () => wsClient.send(JSON.stringify(payload));
        wsClient.onmessage = (msg: any) => {
            const responseData = JSON.parse(msg.data);
            expect(responseData.action).to.be.eq('getStats');
            expect(responseData.success).to.be.eq(1);
            expect(responseData.result.orderCount).to.be.eq(0);
            done();
        };
    });
    it('executes addOrderAsync and removeOrder requests correctly', async () => {
        signedOrder = await fillScenarios.createFillableSignedOrderAsync(
            makerAssetData,
            takerAssetData,
            makerAddress,
            takerAddress,
            fillableAmount,
        );
        const orderHash = orderHashUtils.getOrderHashHex(signedOrder);
        const addOrderPayload = {
            action: 'addOrderAsync',
            params: {'signedOrder': signedOrder},
        };
        const removeOrderPayload = {
            action: 'removeOrder',
            params: {'orderHash': orderHash},
        };

        wsClient.send(JSON.stringify(addOrderPayload));
        const addOrderMsg = await _onMessageAsync(wsClient);
        const addOrderData = JSON.parse(addOrderMsg.data);
        expect(addOrderData.action).to.be.eq('addOrderAsync');
        expect(addOrderData.success).to.be.eq(1);
        expect((wsServer._orderWatcher as any)._orderByOrderHash).to.deep.include({
            [orderHash]: signedOrder,
        });

        wsClient.send(JSON.stringify(removeOrderPayload));
        const removeOrderMsg = await _onMessageAsync(wsClient);
        const removeOrderData = JSON.parse(removeOrderMsg.data);
        expect(removeOrderData.action).to.be.eq('removeOrder');
        expect(removeOrderData.success).to.be.eq(1);
        expect((wsServer._orderWatcher as any)._orderByOrderHash).to.not.deep.include({
            [orderHash]: signedOrder,
        });

    });
    it('broadcasts orderStateInvalid message when makerAddress allowance set to 0 for watched order', async () => {
        signedOrder = await fillScenarios.createFillableSignedOrderAsync(
            makerAssetData,
            takerAssetData,
            makerAddress,
            takerAddress,
            fillableAmount,
        );
        const orderHash = orderHashUtils.getOrderHashHex(signedOrder);
        const addOrderPayload = {
            action: 'addOrderAsync',
            params: {'signedOrder': signedOrder},
        };
        wsClient.send(JSON.stringify(addOrderPayload));
        await _onMessageAsync(wsClient);

        await contractWrappers.erc20Token.setProxyAllowanceAsync(
            makerTokenAddress,
            makerAddress,
            new BigNumber(0),
        );
        const orderWatcherUpdateMsg = await _onMessageAsync(wsClient);
        const orderWatcherUpdateData = JSON.parse(orderWatcherUpdateMsg.data);
        expect(orderWatcherUpdateData.action).to.be.eq('orderWatcherUpdate');
        expect(orderWatcherUpdateData.success).to.be.eq(1);
        const invalidOrderState = orderWatcherUpdateData.result as OrderStateInvalid;
        expect(invalidOrderState.isValid).to.be.false();
        expect(invalidOrderState.orderHash).to.be.eq(orderHash);
        expect(invalidOrderState.error).to.be.eq(ExchangeContractErrs.InsufficientMakerAllowance);
    });
    it('broadcasts to multiple clients when orders backing ZRX allowance changes', async () => {
        // Set up a second client
        wsClientTwo = new WebSocket.w3cwebsocket('ws://127.0.0.1:8080/');
        logUtils.log(`${new Date()} [Client] Connected.`);

        // Prepare order and have second client add it
        const makerFee = Web3Wrapper.toBaseUnitAmount(new BigNumber(2), decimals);
        const takerFee = Web3Wrapper.toBaseUnitAmount(new BigNumber(0), decimals);
        signedOrder = await fillScenarios.createFillableSignedOrderWithFeesAsync(
            makerAssetData,
            takerAssetData,
            makerFee,
            takerFee,
            makerAddress,
            takerAddress,
            fillableAmount,
            takerAddress,
        );
        const addOrderPayload = {
            action: 'addOrderAsync',
            params: {'signedOrder': signedOrder},
        };
        wsClientTwo.send(JSON.stringify(addOrderPayload));
        await _onMessageAsync(wsClientTwo);

        // Change allowance
        await contractWrappers.erc20Token.setProxyAllowanceAsync(
            zrxTokenAddress,
            makerAddress,
            new BigNumber(0),
        );

        // Check that both clients receive the emitted event
        for (const client of [wsClient, wsClientTwo]) {
            const updateMsg = await _onMessageAsync(client);
            const updateData = JSON.parse(updateMsg.data);
            const orderState = updateData.result as OrderStateValid;
            expect(orderState.isValid).to.be.true();
            expect(orderState.orderRelevantState.makerFeeProxyAllowance).to.be.eq('0');
        }
    });
});
