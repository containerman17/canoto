import * as protobuf from "protobufjs";
import * as fs from "fs";
import { it, describe, expect } from "vitest";
import { parse, stringify } from 'lossless-json'

function toHex(arr: Uint8Array): string {
    let output = ''
    arr.forEach(code => {
        output += code.toString(16).padStart(2, '0');
    });
    return output;
}

describe("marshal", () => {
    it("marshals canonical representation", () => {
        const protoStr = fs.readFileSync("./internal/canoto.proto", "utf8")
        const inputJson = fs.readFileSync("./internal/testdata/scalarsDev.json", "utf8")
        const expectedObjectHex = fs.readFileSync("./internal/testdata/scalarsDev.hex", "utf8").trim()
        const actualObjectBuffer = canotoMarshal(protoStr, parse(inputJson), "Scalars")
        expect(toHex(actualObjectBuffer)).toEqual(expectedObjectHex)
    })
})

function canotoMarshal(protobufFile: string, object: any, objectName: string): Uint8Array {
    //FIXME: very inefficient to parse the proto file every time
    const root = protobuf.parse(protobufFile).root
    let result = new Uint8Array(0)

    const namespaces = Object.keys(root?.nested ?? {})
    if (namespaces.length !== 1) {
        throw new Error("Expected exactly one namespace in proto file")
    }
    const namespace = namespaces[0]

    //@ts-ignore nested property indeed exists
    const objType = root.nested?.[namespace]?.nested?.[objectName] as any as protobuf.Type
    if (!objType) {
        throw new Error(`No object type found in proto file for ${objectName}. Available objects: ${Object.keys(root.nested?.[namespace] ?? {})}`)
    }

    for (const fieldId in objType.fieldsById) {
        const field = objType.fieldsById[fieldId] as protobuf.Field & protobuf.IField;
        if (Object.hasOwn(object, field.name)) {
            const value = object[field.name]
            const type = field.type

            // Get wire type based on field type
            let wireType = 0; // Default to VARINT
            if (type === "string" || type === "bytes") {
                wireType = 2; // LEN for string/bytes
            } else if (type === "fixed32" || type === "sfixed32" || type === "float") {
                wireType = 5; // I32 for 4-byte values
            } else if (type === "fixed64" || type === "sfixed64" || type === "double") {
                wireType = 1; // I64 for 8-byte values
            }

            // Get tag (field number << 3 | wire_type)
            const fieldNumber = parseInt(fieldId)
            const tag = (fieldNumber << 3) | wireType

            // Create a buffer for this field
            const tagBuffer = encodeVarint(tag)

            // Get the marshaling function for this type
            const marshalFunc = marshalFuncs[type]
            if (!marshalFunc) {
                throw new Error(`No marshal function found for type ${type}`)
            }

            const valueBuffer = marshalFunc(value)

            // Add to result
            result = concatUint8Arrays(result, tagBuffer)
            result = concatUint8Arrays(result, valueBuffer)
        }
    }

    return result
}

// Helper function to concatenate Uint8Arrays
function concatUint8Arrays(a: Uint8Array, b: Uint8Array): Uint8Array {
    const result = new Uint8Array(a.length + b.length)
    result.set(a, 0)
    result.set(b, a.length)
    return result
}

// Helper function to encode a number as a varint
function encodeVarint(value: number): Uint8Array {
    const result: number[] = []

    while (value > 0x7F) {
        result.push((value & 0x7F) | 0x80)
        value >>>= 7
    }
    result.push(value & 0x7F)

    return new Uint8Array(result)
}

// Helper function to encode a string
function encodeString(str: string): Uint8Array {
    // Convert string to UTF-8 encoded bytes
    const encoder = new TextEncoder();
    const bytes = encoder.encode(str);

    // Prepend the length as a varint
    const lengthBuffer = encodeVarint(bytes.length);

    return concatUint8Arrays(lengthBuffer, bytes);
}

// Helper function to encode bytes
function encodeBytes(bytes: Uint8Array | string): Uint8Array {
    // If input is a base64 string, convert it to bytes
    let byteArray: Uint8Array;
    if (typeof bytes === 'string') {
        byteArray = Uint8Array.from(atob(bytes), c => c.charCodeAt(0));
    } else {
        byteArray = bytes;
    }

    // Prepend the length as a varint
    const lengthBuffer = encodeVarint(byteArray.length);

    return concatUint8Arrays(lengthBuffer, byteArray);
}

// Helper function to encode fixed32
function encodeFixed32(value: number): Uint8Array {
    const buffer = new ArrayBuffer(4);
    const view = new DataView(buffer);
    view.setUint32(0, value, true); // true = little endian
    return new Uint8Array(buffer);
}

// Helper function to encode fixed64
function encodeFixed64(value: number | bigint): Uint8Array {
    const buffer = new ArrayBuffer(8);
    const view = new DataView(buffer);
    const bytes = new Uint8Array(buffer);

    // Handle both number and BigInt
    let valueBigInt = typeof value === 'bigint' ? value : BigInt(value);

    // Encode 8 bytes in little-endian order
    for (let i = 0; i < 8; i++) {
        bytes[i] = Number(valueBigInt & BigInt(0xFF));
        valueBigInt = valueBigInt >> BigInt(8);
    }

    return bytes;
}

// Helper function to encode zigzag
function encodeZigZag32(value: number): number {
    return (value << 1) ^ (value >> 31);
}

function encodeZigZag64(value: number | bigint): bigint {
    const valueBigInt = typeof value === 'bigint' ? value : BigInt(value);
    return (valueBigInt << BigInt(1)) ^ (valueBigInt >> BigInt(63));
}

// Update the marshaling functions with all supported types
const marshalFuncs: Record<string, (value: any) => Uint8Array> = {
    // VARINT wire type (0)
    "int32": (value: number) => encodeVarint(value),
    "int64": (value: number | bigint) => {
        const valueBigInt = typeof value === 'bigint' ? value : BigInt(value);
        // Convert BigInt to byte array in little-endian order
        const bytes: number[] = [];
        let tempValue = valueBigInt;

        while (tempValue > BigInt(0x7F)) {
            bytes.push(Number((tempValue & BigInt(0x7F)) | BigInt(0x80)));
            tempValue >>= BigInt(7);
        }
        bytes.push(Number(tempValue));

        return new Uint8Array(bytes);
    },
    "uint32": (value: number) => encodeVarint(value),
    "uint64": (value: number | bigint) => {
        const valueBigInt = typeof value === 'bigint' ? value : BigInt(value);
        // Convert BigInt to byte array in little-endian order
        const bytes: number[] = [];
        let tempValue = valueBigInt;

        while (tempValue > BigInt(0x7F)) {
            bytes.push(Number((tempValue & BigInt(0x7F)) | BigInt(0x80)));
            tempValue >>= BigInt(7);
        }
        bytes.push(Number(tempValue));

        return new Uint8Array(bytes);
    },
    "sint32": (value: number) => encodeVarint(encodeZigZag32(value)),
    "sint64": (value: number) => {
        const zigzag = encodeZigZag64(value);
        // Now encode the zigzag value as a varint
        const bytes: number[] = [];
        let tempValue = zigzag;

        while (tempValue > BigInt(0x7F)) {
            bytes.push(Number((tempValue & BigInt(0x7F)) | BigInt(0x80)));
            tempValue >>= BigInt(7);
        }
        bytes.push(Number(tempValue));

        return new Uint8Array(bytes);
    },
    "bool": (value: boolean) => encodeVarint(value ? 1 : 0),

    // I32 wire type (5)
    "fixed32": (value: number) => encodeFixed32(value),
    "sfixed32": (value: number) => encodeFixed32(value), // Same encoding, different interpretation

    // I64 wire type (1)
    "fixed64": (value: number | bigint) => encodeFixed64(value),
    "sfixed64": (value: number | bigint) => encodeFixed64(value), // Same encoding, different interpretation

    // LEN wire type (2)
    "string": (value: string) => encodeString(value),
    "bytes": (value: string) => encodeBytes(value),
}
