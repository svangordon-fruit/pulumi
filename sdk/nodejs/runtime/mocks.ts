// Copyright 2016-2018, Pulumi Corporation.
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

import { deserializeProperties, serializeProperties } from "./rpc";
import { getProject, getStack, setMockOptions } from "./settings";

const provproto = require("../proto/provider_pb.js");
const resproto = require("../proto/resource_pb.js");
const structproto = require("google-protobuf/google/protobuf/struct_pb.js");

/**
 * Mocks is an abstract class that allows subclasses to replace operations normally implemented by the Pulumi engine with
 * their own implementations. This can be used during testing to ensure that calls to provider functions and resource constructors
 * return predictable values.
 */
export interface Mocks {
    /**
     * Mocks provider-implemented function calls (e.g. aws.get_availability_zones).
     *
     * @param token: The token that indicates which function is being called. This token is of the form "package:module:function".
     * @param args: The arguments provided to the function call.
     * @param provider: If provided, the identifier of the provider instance being used to make the call.
     */
    call(token: string, args: any, provider?: string): Record<string, any>;

    /**
     * Mocks resource construction calls. This function should return the physical identifier and the output properties
     * for the resource being constructed.
     *
     * @param type: The token that indicates which resource type is being constructed. This token is of the form "package:module:type".
     * @param name: The logical name of the resource instance.
     * @param inputs: The inputs for the resource.
     * @param provider: If provided, the identifier of the provider instance being used to manage this resource.
     * @param id: If provided, the physical identifier of an existing resource to read or import.
     * @param custom: Specifies whether or not the resource is Custom (i.e. managed by a resource provider). This is always set, but marked optional for backwards compatibility.
     */
    newResource(type: string, name: string, inputs: any, provider?: string, id?: string, custom?: boolean): { id: string | undefined, state: Record<string, any> };
}

export class MockMonitor {
    readonly resources = new Map<string, { urn: string, id: string | undefined, state: any }>();

    constructor(readonly mocks: Mocks) {
    }

    private newUrn(parent: string, type: string, name: string): string {
        if (parent) {
            const qualifiedType = parent.split("::")[2];
            const parentType = qualifiedType.split("$").pop();
            type = parentType + "$" + type;
        }
        return "urn:pulumi:" + [getStack(), getProject(), type, name].join("::");
    }

    public async invoke(req: any, callback: (err: any, innerResponse: any) => void) {
        try {
            const tok = req.getTok();
            const inputs = deserializeProperties(req.getArgs());

            if (tok === "pulumi:pulumi:getResource") {
                const registeredResource = this.resources.get(inputs.urn);
                if (!registeredResource) {
                    throw new Error(`unknown resource ${inputs.urn}`);
                }
                const resp = new provproto.InvokeResponse();
                resp.setReturn(structproto.Struct.fromJavaScript(registeredResource));
                callback(null, resp);
                return;
            }

            const result = this.mocks.call(tok, inputs, req.getProvider());
            const response = new provproto.InvokeResponse();
            response.setReturn(structproto.Struct.fromJavaScript(await serializeProperties("", result)));
            callback(null, response);
        } catch (err) {
            callback(err, undefined);
        }
    }

    public async readResource(req: any, callback: (err: any, innterResponse: any) => void) {
        try {
            const result = this.mocks.newResource(
                req.getType(),
                req.getName(),
                deserializeProperties(req.getProperties()),
                req.getProvider(),
                req.getId(),
                req.getCustom());

            const urn = this.newUrn(req.getParent(), req.getType(), req.getName());
            const serializedState = await serializeProperties("", result.state);

            this.resources.set(urn, { urn, id: result.id, state: serializedState });

            const response = new resproto.ReadResourceResponse();
            response.setUrn(urn);
            response.setProperties(structproto.Struct.fromJavaScript(serializedState));
            callback(null, response);
        } catch (err) {
            callback(err, undefined);
        }
    }

    public async registerResource(req: any, callback: (err: any, innerResponse: any) => void) {
        try {
            const result = this.mocks.newResource(
                req.getType(),
                req.getName(),
                deserializeProperties(req.getObject()),
                req.getProvider(),
                req.getImportid(),
                req.getCustom());

            const urn = this.newUrn(req.getParent(), req.getType(), req.getName());
            const serializedState = await serializeProperties("", result.state);

            this.resources.set(urn, { urn, id: result.id, state: serializedState });

            const response = new resproto.RegisterResourceResponse();
            response.setUrn(urn);
            response.setId(result.id);
            response.setObject(structproto.Struct.fromJavaScript(serializedState));
            callback(null, response);
        } catch (err) {
            callback(err, undefined);
        }
    }

    public registerResourceOutputs(req: any, callback: (err: any, innerResponse: any) => void) {
        try {
            const registeredResource = this.resources.get(req.getUrn());
            if (!registeredResource) {
                throw new Error(`unknown resource ${req.getUrn()}`);
            }
            registeredResource.state = req.getOutputs();

            callback(null, {});
        } catch (err) {
            callback(err, undefined);
        }
    }

    public supportsFeature(req: any, callback: (err: any, innerResponse: any) => void) {
        callback(null, {
            getHassupport: () => true,
        });
    }
}

/**
 * setMocks configures the Pulumi runtime to use the given mocks for testing.
 *
 * @param mocks: The mocks to use for calls to provider functions and resource consrtuction.
 * @param project: If provided, the name of the Pulumi project. Defaults to "project".
 * @param stack: If provided, the name of the Pulumi stack. Defaults to "stack".
 * @param preview: If provided, indicates whether or not the program is running a preview. Defaults to false.
 */
export function setMocks(mocks: Mocks, project?: string, stack?: string, preview?: boolean) {
    setMockOptions(new MockMonitor(mocks), project, stack, preview);
}
