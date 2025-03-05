import * as protobuf from "protobufjs";
import * as fs from "fs";
import { it, describe, expect } from "vitest";

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
        const actualObjectBuffer = canotoMarshal(protoStr, JSON.parse(inputJson), "Scalars")
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

// Update the marshaling functions
const marshalFuncs: Record<string, (value: any) => Uint8Array> = {
    "int32": (value: number) => encodeVarint(value),
    "uint32": (value: number) => encodeVarint(value),
    "bool": (value: boolean) => encodeVarint(value ? 1 : 0),
    "string": (value: string) => encodeString(value),
    // We can add more types as needed
}
