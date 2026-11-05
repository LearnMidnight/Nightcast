import * as __compactRuntime from '@midnight-ntwrk/compact-runtime';
__compactRuntime.checkRuntimeVersion('0.16.0');

const _descriptor_0 = new __compactRuntime.CompactTypeUnsignedInteger(65535n, 2);

const _descriptor_1 = new __compactRuntime.CompactTypeBytes(32);

const _descriptor_2 = new __compactRuntime.CompactTypeUnsignedInteger(4294967295n, 4);

const _descriptor_3 = __compactRuntime.CompactTypeField;

class _WordPreimage_0 {
  alignment() {
    return _descriptor_1.alignment().concat(_descriptor_1.alignment().concat(_descriptor_2.alignment()));
  }
  fromValue(value_0) {
    return {
      domain: _descriptor_1.fromValue(value_0),
      output: _descriptor_1.fromValue(value_0),
      index: _descriptor_2.fromValue(value_0)
    }
  }
  toValue(value_0) {
    return _descriptor_1.toValue(value_0.domain).concat(_descriptor_1.toValue(value_0.output).concat(_descriptor_2.toValue(value_0.index)));
  }
}

const _descriptor_4 = new _WordPreimage_0();

const _descriptor_5 = new __compactRuntime.CompactTypeUnsignedInteger(18446744073709551615n, 8);

const _descriptor_6 = __compactRuntime.CompactTypeBoolean;

class _Either_0 {
  alignment() {
    return _descriptor_6.alignment().concat(_descriptor_1.alignment().concat(_descriptor_1.alignment()));
  }
  fromValue(value_0) {
    return {
      is_left: _descriptor_6.fromValue(value_0),
      left: _descriptor_1.fromValue(value_0),
      right: _descriptor_1.fromValue(value_0)
    }
  }
  toValue(value_0) {
    return _descriptor_6.toValue(value_0.is_left).concat(_descriptor_1.toValue(value_0.left).concat(_descriptor_1.toValue(value_0.right)));
  }
}

const _descriptor_7 = new _Either_0();

const _descriptor_8 = new __compactRuntime.CompactTypeUnsignedInteger(340282366920938463463374607431768211455n, 16);

class _ContractAddress_0 {
  alignment() {
    return _descriptor_1.alignment();
  }
  fromValue(value_0) {
    return {
      bytes: _descriptor_1.fromValue(value_0)
    }
  }
  toValue(value_0) {
    return _descriptor_1.toValue(value_0.bytes);
  }
}

const _descriptor_9 = new _ContractAddress_0();

const _descriptor_10 = new __compactRuntime.CompactTypeUnsignedInteger(255n, 1);

export class Contract {
  witnesses;
  constructor(...args_0) {
    if (args_0.length !== 1) {
      throw new __compactRuntime.CompactError(`Contract constructor: expected 1 argument, received ${args_0.length}`);
    }
    const witnesses_0 = args_0[0];
    if (typeof(witnesses_0) !== 'object') {
      throw new __compactRuntime.CompactError('first (witnesses) argument to Contract constructor is not an object');
    }
    this.witnesses = witnesses_0;
    this.circuits = {
      probe: (...args_1) => {
        if (args_1.length !== 6) {
          throw new __compactRuntime.CompactError(`probe: expected 6 arguments (as invoked from Typescript), received ${args_1.length}`);
        }
        const contextOrig_0 = args_1[0];
        const output_0 = args_1[1];
        const index_0 = args_1[2];
        const sha_0 = args_1[3];
        const poseidon_0 = args_1[4];
        const field_0 = args_1[5];
        if (!(typeof(contextOrig_0) === 'object' && contextOrig_0.currentQueryContext != undefined)) {
          __compactRuntime.typeError('probe',
                                     'argument 1 (as invoked from Typescript)',
                                     'words-probe.compact line 13 char 1',
                                     'CircuitContext',
                                     contextOrig_0)
        }
        if (!(output_0.buffer instanceof ArrayBuffer && output_0.BYTES_PER_ELEMENT === 1 && output_0.length === 32)) {
          __compactRuntime.typeError('probe',
                                     'argument 1 (argument 2 as invoked from Typescript)',
                                     'words-probe.compact line 13 char 1',
                                     'Bytes<32>',
                                     output_0)
        }
        if (!(typeof(index_0) === 'bigint' && index_0 >= 0n && index_0 <= 4294967295n)) {
          __compactRuntime.typeError('probe',
                                     'argument 2 (argument 3 as invoked from Typescript)',
                                     'words-probe.compact line 13 char 1',
                                     'Uint<0..4294967296>',
                                     index_0)
        }
        if (!(sha_0.buffer instanceof ArrayBuffer && sha_0.BYTES_PER_ELEMENT === 1 && sha_0.length === 32)) {
          __compactRuntime.typeError('probe',
                                     'argument 3 (argument 4 as invoked from Typescript)',
                                     'words-probe.compact line 13 char 1',
                                     'Bytes<32>',
                                     sha_0)
        }
        if (!(poseidon_0.buffer instanceof ArrayBuffer && poseidon_0.BYTES_PER_ELEMENT === 1 && poseidon_0.length === 32)) {
          __compactRuntime.typeError('probe',
                                     'argument 4 (argument 5 as invoked from Typescript)',
                                     'words-probe.compact line 13 char 1',
                                     'Bytes<32>',
                                     poseidon_0)
        }
        if (!(typeof(field_0) === 'bigint' && field_0 >= 0 && field_0 <= __compactRuntime.MAX_FIELD)) {
          __compactRuntime.typeError('probe',
                                     'argument 5 (argument 6 as invoked from Typescript)',
                                     'words-probe.compact line 13 char 1',
                                     'Field',
                                     field_0)
        }
        const context = { ...contextOrig_0, gasCost: __compactRuntime.emptyRunningCost() };
        const partialProofData = {
          input: {
            value: _descriptor_1.toValue(output_0).concat(_descriptor_2.toValue(index_0).concat(_descriptor_1.toValue(sha_0).concat(_descriptor_1.toValue(poseidon_0).concat(_descriptor_3.toValue(field_0))))),
            alignment: _descriptor_1.alignment().concat(_descriptor_2.alignment().concat(_descriptor_1.alignment().concat(_descriptor_1.alignment().concat(_descriptor_3.alignment()))))
          },
          output: undefined,
          publicTranscript: [],
          privateTranscriptOutputs: []
        };
        const result_0 = this._probe_0(context,
                                       partialProofData,
                                       output_0,
                                       index_0,
                                       sha_0,
                                       poseidon_0,
                                       field_0);
        partialProofData.output = { value: [], alignment: [] };
        return { result: result_0, context: context, proofData: partialProofData, gasCost: context.gasCost };
      }
    };
    this.impureCircuits = { probe: this.circuits.probe };
    this.provableCircuits = { probe: this.circuits.probe };
  }
  initialState(...args_0) {
    if (args_0.length !== 1) {
      throw new __compactRuntime.CompactError(`Contract state constructor: expected 1 argument (as invoked from Typescript), received ${args_0.length}`);
    }
    const constructorContext_0 = args_0[0];
    if (typeof(constructorContext_0) !== 'object') {
      throw new __compactRuntime.CompactError(`Contract state constructor: expected 'constructorContext' in argument 1 (as invoked from Typescript) to be an object`);
    }
    if (!('initialZswapLocalState' in constructorContext_0)) {
      throw new __compactRuntime.CompactError(`Contract state constructor: expected 'initialZswapLocalState' in argument 1 (as invoked from Typescript)`);
    }
    if (typeof(constructorContext_0.initialZswapLocalState) !== 'object') {
      throw new __compactRuntime.CompactError(`Contract state constructor: expected 'initialZswapLocalState' in argument 1 (as invoked from Typescript) to be an object`);
    }
    const state_0 = new __compactRuntime.ContractState();
    let stateValue_0 = __compactRuntime.StateValue.newArray();
    stateValue_0 = stateValue_0.arrayPush(__compactRuntime.StateValue.newNull());
    state_0.data = new __compactRuntime.ChargedState(stateValue_0);
    state_0.setOperation('probe', new __compactRuntime.ContractOperation());
    const context = __compactRuntime.createCircuitContext(__compactRuntime.dummyContractAddress(), constructorContext_0.initialZswapLocalState.coinPublicKey, state_0.data, constructorContext_0.initialPrivateState);
    const partialProofData = {
      input: { value: [], alignment: [] },
      output: undefined,
      publicTranscript: [],
      privateTranscriptOutputs: []
    };
    __compactRuntime.queryLedgerState(context,
                                      partialProofData,
                                      [
                                       { push: { storage: false,
                                                 value: __compactRuntime.StateValue.newCell({ value: _descriptor_10.toValue(0n),
                                                                                              alignment: _descriptor_10.alignment() }).encode() } },
                                       { push: { storage: true,
                                                 value: __compactRuntime.StateValue.newCell({ value: _descriptor_5.toValue(0n),
                                                                                              alignment: _descriptor_5.alignment() }).encode() } },
                                       { ins: { cached: false, n: 1 } }]);
    state_0.data = new __compactRuntime.ChargedState(context.currentQueryContext.state.state);
    return {
      currentContractState: state_0,
      currentPrivateState: context.currentPrivateState,
      currentZswapLocalState: context.currentZswapLocalState
    }
  }
  _transientHash_0(value_0) {
    const result_0 = __compactRuntime.transientHash(_descriptor_4, value_0);
    return result_0;
  }
  _persistentHash_0(value_0) {
    const result_0 = __compactRuntime.persistentHash(_descriptor_4, value_0);
    return result_0;
  }
  _upgradeFromTransient_0(x_0) {
    const result_0 = __compactRuntime.upgradeFromTransient(x_0);
    return result_0;
  }
  _randomWord_0(output_0, index_0) {
    return this._persistentHash_0({ domain:
                                      new Uint8Array([110, 105, 103, 104, 116, 99, 97, 115, 116, 58, 119, 111, 114, 100, 58, 118, 48, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]),
                                    output: output_0,
                                    index: index_0 });
  }
  _randomWordPoseidonField_0(output_0, index_0) {
    return this._transientHash_0({ domain:
                                     new Uint8Array([110, 105, 103, 104, 116, 99, 97, 115, 116, 58, 119, 111, 114, 100, 58, 112, 111, 115, 101, 105, 100, 111, 110, 58, 118, 48, 0, 0, 0, 0, 0, 0]),
                                   output: output_0,
                                   index: index_0 });
  }
  _randomWordPoseidon_0(output_0, index_0) {
    return this._upgradeFromTransient_0(this._randomWordPoseidonField_0(output_0,
                                                                        index_0));
  }
  _probe_0(context,
           partialProofData,
           output_0,
           index_0,
           sha_0,
           poseidon_0,
           field_0)
  {
    const o_0 = output_0;
    const i_0 = index_0;
    __compactRuntime.assert(this._equal_0(this._randomWord_0(o_0, i_0), sha_0),
                            'SHA-256 word differs');
    __compactRuntime.assert(this._equal_1(this._randomWordPoseidon_0(o_0, i_0),
                                          poseidon_0),
                            'Poseidon word differs');
    __compactRuntime.assert(this._randomWordPoseidonField_0(o_0, i_0)
                            ===
                            field_0,
                            'Poseidon field differs');
    const tmp_0 = 1n;
    __compactRuntime.queryLedgerState(context,
                                      partialProofData,
                                      [
                                       { idx: { cached: false,
                                                pushPath: true,
                                                path: [
                                                       { tag: 'value',
                                                         value: { value: _descriptor_10.toValue(0n),
                                                                  alignment: _descriptor_10.alignment() } }] } },
                                       { addi: { immediate: parseInt(__compactRuntime.valueToBigInt(
                                                              { value: _descriptor_0.toValue(tmp_0),
                                                                alignment: _descriptor_0.alignment() }
                                                                .value
                                                            )) } },
                                       { ins: { cached: true, n: 1 } }]);
    return [];
  }
  _equal_0(x0, y0) {
    if (!x0.every((x, i) => y0[i] === x)) { return false; }
    return true;
  }
  _equal_1(x0, y0) {
    if (!x0.every((x, i) => y0[i] === x)) { return false; }
    return true;
  }
}
export function ledger(stateOrChargedState) {
  const state = stateOrChargedState instanceof __compactRuntime.StateValue ? stateOrChargedState : stateOrChargedState.state;
  const chargedState = stateOrChargedState instanceof __compactRuntime.StateValue ? new __compactRuntime.ChargedState(stateOrChargedState) : stateOrChargedState;
  const context = {
    currentQueryContext: new __compactRuntime.QueryContext(chargedState, __compactRuntime.dummyContractAddress()),
    costModel: __compactRuntime.CostModel.initialCostModel()
  };
  const partialProofData = {
    input: { value: [], alignment: [] },
    output: undefined,
    publicTranscript: [],
    privateTranscriptOutputs: []
  };
  return {
    get checks() {
      return _descriptor_5.fromValue(__compactRuntime.queryLedgerState(context,
                                                                       partialProofData,
                                                                       [
                                                                        { dup: { n: 0 } },
                                                                        { idx: { cached: false,
                                                                                 pushPath: false,
                                                                                 path: [
                                                                                        { tag: 'value',
                                                                                          value: { value: _descriptor_10.toValue(0n),
                                                                                                   alignment: _descriptor_10.alignment() } }] } },
                                                                        { popeq: { cached: true,
                                                                                   result: undefined } }]).value);
    }
  };
}
const _emptyContext = {
  currentQueryContext: new __compactRuntime.QueryContext(new __compactRuntime.ContractState().data, __compactRuntime.dummyContractAddress())
};
const _dummyContract = new Contract({ });
export const pureCircuits = {};
export const contractReferenceLocations =
  { tag: 'publicLedgerArray', indices: { } };
//# sourceMappingURL=index.js.map
