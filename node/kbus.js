/**
 * Copyright JS Foundation and other contributors, http://js.foundation
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 **/

 module.exports = function(RED) {
    "use strict";
    var mqtt = require("mqtt");
    var util = require("util");
    var isUtf8 = require('is-utf8');
    var HttpsProxyAgent = require('https-proxy-agent');
    var url = require('url');

    function matchTopic(ts,t) {
        if (ts == "#") {
            return true;
        }
        /* The following allows shared subscriptions (as in MQTT v5)
           http://docs.oasis-open.org/mqtt/mqtt/v5.0/cs02/mqtt-v5.0-cs02.html#_Toc514345522

           4.8.2 describes shares like:
           $share/{ShareName}/{filter}
           $share is a literal string that marks the Topic Filter as being a Shared Subscription Topic Filter.
           {ShareName} is a character string that does not include "/", "+" or "#"
           {filter} The remainder of the string has the same syntax and semantics as a Topic Filter in a non-shared subscription. Refer to section 4.7.
        */
        else if(ts.startsWith("$share")){
            ts = ts.replace(/^\$share\/[^#+/]+\/(.*)/g,"$1");

        }
        var re = new RegExp("^"+ts.replace(/([\[\]\?\(\)\\\\$\^\*\.|])/g,"\\$1").replace(/\+/g,"[^/]+").replace(/\/#$/,"(\/.*)?")+"$");
        return re.test(t);
    }

    /**
     * Helper function for setting integer property values in the MQTT V5 properties object
     * @param {object} src Source object containing properties
     * @param {object} dst Destination object to set/add properties
     * @param {string} propName The property name to set in the Destination object
     * @param {integer} [minVal] The minimum value. If the src value is less than minVal, it will NOT be set in the destination
     * @param {integer} [maxVal] The maximum value. If the src value is greater than maxVal, it will NOT be set in the destination
     * @param {integer} [def] An optional default to set in the destination object if prop is NOT present in the soruce object
     */
    function setIntProp(src, dst, propName, minVal, maxVal, def) {
        if (src.hasOwnProperty(propName)) {
            var v = parseInt(src[propName]);
            if(isNaN(v)) return;
            if(minVal != null) {
                if(v < minVal) return;
            }
            if(maxVal != null) {
                if(v > maxVal) return;
            }
            dst[propName] = v;
        } else {
            if(def != undefined) dst[propName] = def;
        }
    }

    /**
     * Helper function for setting string property values in the MQTT V5 properties object
     * @param {object} src Source object containing properties
     * @param {object} dst Destination object to set/add properties
     * @param {string} propName The property name to set in the Destination object
     * @param {string} [def] An optional default to set in the destination object if prop is NOT present in the soruce object
     */
    function setStrProp(src, dst, propName, def) {
        if (src[propName] && typeof src[propName] == "string") {
            dst[propName] = src[propName];
        } else {
            if(def != undefined) dst[propName] = def;
        }
    }

    /**
     * Helper function for setting boolean property values in the MQTT V5 properties object
     * @param {object} src Source object containing properties
     * @param {object} dst Destination object to set/add properties
     * @param {string} propName The property name to set in the Destination object
     * @param {boolean} [def] An optional default to set in the destination object if prop is NOT present in the soruce object
     */
    function setBoolProp(src, dst, propName, def) {
        if (src[propName] != null) {
            if(src[propName] === "true" || src[propName] === true) {
                dst[propName] = true;
            } else if(src[propName] === "false" || src[propName] === false) {
                dst[propName] = true;
            }
        } else {
            if(def != undefined) dst[propName] = def;
        }
    }

    /**
     * Helper function for copying the MQTT v5 srcUserProperties object (parameter1) to the properties object (parameter2).
     * Any property in srcUserProperties that is NOT a key/string pair will be silently discarded.
     * NOTE: if no sutable properties are present, the userProperties object will NOT be added to the properties object
     * @param {object} srcUserProperties An object with key/value string pairs
     * @param {object} properties A properties object in which userProperties will be copied to
     */
    function setUserProperties(srcUserProperties, properties) {
        if (srcUserProperties && typeof srcUserProperties == "object") {
            let _clone = {};
            let count = 0;
            let keys = Object.keys(srcUserProperties);
            if(!keys || !keys.length) return null;
            keys.forEach(key => {
                let val = srcUserProperties[key];
                if(typeof val == "string") {
                    count++;
                    _clone[key] = val;
                }
            });
            if(count) properties.userProperties = _clone;
        }
    }

    /**
     * Helper function for copying the MQTT v5 buffer type properties
     * NOTE: if src[propName] is not a buffer, dst[propName] will NOT be assigned a value (unless def is set)
     * @param {object} src Source object containing properties
     * @param {object} dst Destination object to set/add properties
     * @param {string} propName The property name to set in the Destination object
     * @param {boolean} [def] An optional default to set in the destination object if prop is NOT present in the Source object
     */
    function setBufferProp(src, dst, propName, def) {
        if(!dst) return;
        if (src && dst) {
            var buf = src[propName];
            if (buf && typeof Buffer.isBuffer(buf)) {
                dst[propName] = Buffer.from(buf);
            }
        } else {
            if(def != undefined) dst[propName] = def;
        }
    }

    function MQTTBrokerNode(n) {
        RED.nodes.createNode(this,n);

        // Configuration options passed by Node Red
        this.broker = n.broker;
        this.port = n.port;
        this.clientid = n.clientid;
        this.usetls = n.usetls;
        this.usews = n.usews;
        this.verifyservercert = n.verifyservercert;
        this.compatmode = n.compatmode;
        this.protocolVersion = n.protocolVersion;
        this.keepalive = n.keepalive;
        this.cleansession = n.cleansession;
        this.sessionExpiryInterval = n.sessionExpiry;
        this.topicAliasMaximum = n.topicAliasMaximum;
        this.maximumPacketSize = n.maximumPacketSize;
        this.receiveMaximum = n.receiveMaximum;
        this.userProperties = n.userProperties;//https://docs.oasis-open.org/mqtt/mqtt/v5.0/os/mqtt-v5.0-os.html#_Toc3901116
        this.userPropertiesType = n.userPropertiesType;

        // Config node state
        this.brokerurl = "";
        this.connected = false;
        this.connecting = false;
        this.closing = false;
        this.options = {};
        this.queue = [];
        this.subscriptions = {};

        if (n.birthTopic) {
            this.birthMessage = {
                topic: n.birthTopic,
                payload: n.birthPayload || "",
                qos: Number(n.birthQos||0),
                retain: n.birthRetain=="true"|| n.birthRetain===true,
                //TODO: add payloadFormatIndicator, messageExpiryInterval, contentType, responseTopic, correlationData, userProperties
            };
            if (n.birthMsg) {
                setStrProp(n.birthMsg, this.birthMessage, "contentType");
                if(n.birthMsg.userProps && /^ *{/.test(n.birthMsg.userProps)) {
                    try {
                        setUserProperties(JSON.parse(n.birthMsg.userProps), this.birthMessage);
                    } catch(err) {}
                }
                n.birthMsg.responseTopic = n.birthMsg.respTopic;
                setStrProp(n.birthMsg, this.birthMessage, "responseTopic");
                n.birthMsg.correlationData = n.birthMsg.correl;
                setBufferProp(n.birthMsg, this.birthMessage, "correlationData");
                n.birthMsg.messageExpiryInterval = n.birthMsg.expiry
                setIntProp(n.birthMsg,this.birthMessage, "messageExpiryInterval")
            }
        }

        if (n.closeTopic) {
            this.closeMessage = {
                topic: n.closeTopic,
                payload: n.closePayload || "",
                qos: Number(n.closeQos||0),
                retain: n.closeRetain=="true"|| n.closeRetain===true,
                //TODO: add payloadFormatIndicator, messageExpiryInterval, contentType, responseTopic, correlationData, userProperties
            };
            if (n.closeMsg) {
                setStrProp(n.closeMsg, this.closeMessage, "contentType");
                if(n.closeMsg.userProps && /^ *{/.test(n.closeMsg.userProps)) {
                    try {
                        setUserProperties(JSON.parse(n.closeMsg.userProps), this.closeMessage);
                    } catch(err) {}
                }
                n.closeMsg.responseTopic = n.closeMsg.respTopic;
                setStrProp(n.closeMsg, this.closeMessage, "responseTopic");
                n.closeMsg.correlationData = n.closeMsg.correl;
                setBufferProp(n.closeMsg, this.closeMessage, "correlationData");
                n.closeMsg.messageExpiryInterval = n.closeMsg.expiry
                setIntProp(n.birthMsg,this.closeMessage, "messageExpiryInterval")
            }
        }

        if (this.credentials) {
            this.username = this.credentials.user;
            this.password = this.credentials.password;
        }

        // If the config node is missing certain options (it was probably deployed prior to an update to the node code),
        // select/generate sensible options for the new fields
        if (typeof this.usetls === 'undefined') {
            this.usetls = false;
        }
        if (typeof this.usews === 'undefined') {
            this.usews = false;
        }
        if (typeof this.verifyservercert === 'undefined') {
            this.verifyservercert = false;
        }
        if (typeof this.keepalive === 'undefined') {
            this.keepalive = 60;
        } else if (typeof this.keepalive === 'string') {
            this.keepalive = Number(this.keepalive);
        }
        if (typeof this.cleansession === 'undefined') {
            this.cleansession = true;
        }

        var prox, noprox;
        if (process.env.http_proxy) { prox = process.env.http_proxy; }
        if (process.env.HTTP_PROXY) { prox = process.env.HTTP_PROXY; }
        if (process.env.no_proxy) { noprox = process.env.no_proxy.split(","); }
        if (process.env.NO_PROXY) { noprox = process.env.NO_PROXY.split(","); }


        // Create the URL to pass in to the MQTT.js library
        if (this.brokerurl === "") {
            // if the broker may be ws:// or wss:// or even tcp://
            if (this.broker.indexOf("://") > -1) {
                this.brokerurl = this.broker;
                // Only for ws or wss, check if proxy env var for additional configuration
                if (this.brokerurl.indexOf("wss://") > -1 || this.brokerurl.indexOf("ws://") > -1 ) {
                    // check if proxy is set in env
                    var noproxy;
                    if (noprox) {
                        for (var i = 0; i < noprox.length; i += 1) {
                            if (this.brokerurl.indexOf(noprox[i].trim()) !== -1) { noproxy=true; }
                        }
                    }
                    if (prox && !noproxy) {
                        var parsedUrl = url.parse(this.brokerurl);
                        var proxyOpts = url.parse(prox);
                        // true for wss
                        proxyOpts.secureEndpoint = parsedUrl.protocol ? parsedUrl.protocol === 'wss:' : true;
                        // Set Agent for wsOption in MQTT
                        var agent = new HttpsProxyAgent(proxyOpts);
                        this.options.wsOptions = {
                            agent: agent
                        }
                    }
                }
            } else {
                // construct the std mqtt:// url
                if (this.usetls) {
                    this.brokerurl="mqtts://";
                } else {
                    this.brokerurl="mqtt://";
                }
                if (this.broker !== "") {
                    //Check for an IPv6 address
                    if (/(?:^|(?<=\s))(([0-9a-fA-F]{1,4}:){7,7}[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,7}:|([0-9a-fA-F]{1,4}:){1,6}:[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,5}(:[0-9a-fA-F]{1,4}){1,2}|([0-9a-fA-F]{1,4}:){1,4}(:[0-9a-fA-F]{1,4}){1,3}|([0-9a-fA-F]{1,4}:){1,3}(:[0-9a-fA-F]{1,4}){1,4}|([0-9a-fA-F]{1,4}:){1,2}(:[0-9a-fA-F]{1,4}){1,5}|[0-9a-fA-F]{1,4}:((:[0-9a-fA-F]{1,4}){1,6})|:((:[0-9a-fA-F]{1,4}){1,7}|:)|fe80:(:[0-9a-fA-F]{0,4}){0,4}%[0-9a-zA-Z]{1,}|::(ffff(:0{1,4}){0,1}:){0,1}((25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])\.){3,3}(25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])|([0-9a-fA-F]{1,4}:){1,4}:((25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])\.){3,3}(25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9]))(?=\s|$)/.test(this.broker)) {
                        this.brokerurl = this.brokerurl+"["+this.broker+"]:";
                    } else {
                        this.brokerurl = this.brokerurl+this.broker+":";
                    }
                    // port now defaults to 1883 if unset.
                    if (!this.port){
                        this.brokerurl = this.brokerurl+"1883";
                    } else {
                        this.brokerurl = this.brokerurl+this.port;
                    }
                } else {
                    this.brokerurl = this.brokerurl+"localhost:1883";
                }
            }
        }

        if (!this.cleansession && !this.clientid) {
            this.cleansession = true;
            this.warn(RED._("mqtt.errors.nonclean-missingclientid"));
        }

        // Build options for passing to the MQTT.js API
        this.options.clientId = this.clientid || 'mqtt_' + (1+Math.random()*4294967295).toString(16);
        this.options.username = this.username;
        this.options.password = this.password;
        this.options.keepalive = this.keepalive;
        this.options.clean = this.cleansession;
        this.options.reconnectPeriod = RED.settings.mqttReconnectTime||5000;
        if (this.compatmode == "true" || this.compatmode === true || this.protocolVersion == 3) {
            this.options.protocolId = 'MQIsdp';
            this.options.protocolVersion = 3;
        } else if ( this.protocolVersion == 5 ) {
            this.options.protocolVersion = 5;
            this.options.properties = {};
            this.options.properties.requestResponseInformation = true;
            this.options.properties.requestProblemInformation = true;
            if(this.userProperties && /^ *{/.test(this.userProperties)) {
                try {
                    setUserProperties(JSON.parse(this.userProperties), this.options.properties);
                } catch(err) {}
            }
            if (this.sessionExpiryInterval && this.sessionExpiryInterval !== "0") {
                setIntProp(this,this.options.properties,"sessionExpiryInterval");
            }
        }
        if (this.usetls && n.tls) {
            var tlsNode = RED.nodes.getNode(n.tls);
            if (tlsNode) {
                tlsNode.addTLSOptions(this.options);
            }
        }

        // If there's no rejectUnauthorized already, then this could be an
        // old config where this option was provided on the broker node and
        // not the tls node
        if (typeof this.options.rejectUnauthorized === 'undefined') {
            this.options.rejectUnauthorized = (this.verifyservercert == "true" || this.verifyservercert === true);
        }

        if (n.willTopic) {
            this.options.will = {
                topic: n.willTopic,
                payload: n.willPayload || "",
                qos: Number(n.willQos||0),
                retain: n.willRetain=="true"|| n.willRetain===true,
                //TODO: add willDelayInterval, payloadFormatIndicator, messageExpiryInterval, contentType, responseTopic, correlationData, userProperties
            };
            if (n.willMsg) {
                this.options.will.properties = {};

                setStrProp(n.willMsg, this.options.will.properties, "contentType");
                if(n.willMsg.userProps && /^ *{/.test(n.willMsg.userProps)) {
                    try {
                        setUserProperties(JSON.parse(n.willMsg.userProps), this.options.will.properties);
                    } catch(err) {}
                }
                n.willMsg.responseTopic = n.willMsg.respTopic;
                setStrProp(n.willMsg, this.options.will.properties, "responseTopic");
                n.willMsg.correlationData = n.willMsg.correl;
                setBufferProp(n.willMsg, this.options.will.properties, "correlationData");
                n.willMsg.willDelayInterval = n.willMsg.delay
                setIntProp(n.willMsg,this.options.will.properties, "willDelayInterval")
                n.willMsg.messageExpiryInterval = n.willMsg.expiry
                setIntProp(n.willMsg,this.options.will.properties, "messageExpiryInterval")
                this.options.will.payloadFormatIndicator = true;
            }
        }

        // console.log(this.brokerurl,this.options);

        // Define functions called by kbus in and out nodes
        var node = this;
        this.users = {};

        this.register = function(mqttNode) {
            node.users[mqttNode.id] = mqttNode;
            if (Object.keys(node.users).length === 1) {
                node.connect();
            }
        };

        this.deregister = function(mqttNode,done) {
            delete node.users[mqttNode.id];
            if (node.closing) {
                return done();
            }
            if (Object.keys(node.users).length === 0) {
                if (node.client && node.client.connected) {
                    // Send close message
                    if (node.closeMessage) {
                        node.publish(node.closeMessage,function(err) {
                            node.client.end(done);
                        });
                    } else {
                        node.client.end(done);
                    }
                    return;
                } else {
                    node.client.end();
                    return done();
                }
            }
            done();
        };

        this.connect = function () {
            if (!node.connected && !node.connecting) {
                node.connecting = true;
                try {
                    node.serverProperties = {};
                    node.client = mqtt.connect(node.brokerurl ,node.options);
                    node.client.setMaxListeners(0);
                    // Register successful connect or reconnect handler
                    node.client.on('connect', function (connack) {
                        node.connecting = false;
                        node.connected = true;
                        node.topicAliases = {};
                        node.log(RED._("mqtt.state.connected",{broker:(node.clientid?node.clientid+"@":"")+node.brokerurl}));
                        if(node.options.protocolVersion == 5 && connack && connack.hasOwnProperty("properties")) {
                            if(typeof connack.properties == "object") {
                                //clean & assign all props sent from server.
                                setIntProp(connack.properties, node.serverProperties, "topicAliasMaximum", 0);
                                setIntProp(connack.properties, node.serverProperties, "receiveMaximum", 0);
                                setIntProp(connack.properties, node.serverProperties, "sessionExpiryInterval", 0, 0xFFFFFFFF);
                                setIntProp(connack.properties, node.serverProperties, "maximumQoS", 0, 2);
                                setBoolProp(connack.properties, node.serverProperties, "retainAvailable",true);
                                setBoolProp(connack.properties, node.serverProperties, "wildcardSubscriptionAvailable", true);
                                setBoolProp(connack.properties, node.serverProperties, "subscriptionIdentifiersAvailable", true);
                                setBoolProp(connack.properties, node.serverProperties, "sharedSubscriptionAvailable");
                                setIntProp(connack.properties, node.serverProperties, "maximumPacketSize", 0);
                                setIntProp(connack.properties, node.serverProperties, "serverKeepAlive");
                                setStrProp(connack.properties, node.serverProperties, "responseInformation");
                                setStrProp(connack.properties, node.serverProperties, "serverReference");
                                setStrProp(connack.properties, node.serverProperties, "assignedClientIdentifier");
                                setStrProp(connack.properties, node.serverProperties, "reasonString");
                                setUserProperties(connack.properties, node.serverProperties);
                                // node.debug("CONNECTED. node.serverProperties ==> "+JSON.stringify(node.serverProperties));//TODO: remove
                            }
                        }
                        for (var id in node.users) {
                            if (node.users.hasOwnProperty(id)) {
                                node.users[id].status({fill:"green",shape:"dot",text:"node-red:common.status.connected"});
                            }
                        }
                        // Remove any existing listeners before resubscribing to avoid duplicates in the event of a re-connection
                        node.client.removeAllListeners('message');

                        // Re-subscribe to stored topics
                        for (var s in node.subscriptions) {
                            if (node.subscriptions.hasOwnProperty(s)) {
                                let topic = s;
                                let qos = 0;
                                let _options = {};
                                for (var r in node.subscriptions[s]) {
                                    if (node.subscriptions[s].hasOwnProperty(r)) {
                                        qos = Math.max(qos,node.subscriptions[s][r].qos);
                                        _options = node.subscriptions[s][r].options;
                                        node.client.on('message',node.subscriptions[s][r].handler);
                                    }
                                }
                                _options.qos = _options.qos || qos;
                                node.client.subscribe(topic, _options);
                            }
                        }

                        // Send any birth message
                        if (node.birthMessage) {
                            node.publish(node.birthMessage);
                        }
                    });
                    node.client.on("reconnect", function() {
                        for (var id in node.users) {
                            if (node.users.hasOwnProperty(id)) {
                                node.users[id].status({fill:"yellow",shape:"ring",text:"node-red:common.status.connecting"});
                            }
                        }
                    });
                    //TODO: what to do with this event? Anything? Necessary?
                    node.client.on("disconnect", function(packet) {
                        //Emitted after receiving disconnect packet from broker. MQTT 5.0 feature.
                        var rc = packet && packet.properties && packet.properties.reasonString;
                        var rc = packet && packet.properties && packet.reasonCode;
                        //TODO: If keeping this event, do we use these? log these?
                    });
                    // Register disconnect handlers
                    node.client.on('close', function () {
                        if (node.connected) {
                            node.connected = false;
                            node.log(RED._("mqtt.state.disconnected",{broker:(node.clientid?node.clientid+"@":"")+node.brokerurl}));
                            for (var id in node.users) {
                                if (node.users.hasOwnProperty(id)) {
                                    node.users[id].status({fill:"red",shape:"ring",text:"node-red:common.status.disconnected"});
                                }
                            }
                        } else if (node.connecting) {
                            node.log(RED._("mqtt.state.connect-failed",{broker:(node.clientid?node.clientid+"@":"")+node.brokerurl}));
                        }
                    });

                    // Register connect error handler
                    // The client's own reconnect logic will take care of errors
                    node.client.on('error', function (error) {
                    });
                }catch(err) {
                    console.log(err);
                }
            }
        };

        this.subscriptionIds = {};
        this.subid = 1;
        this.subscribe = function (topic,options,callback,ref) {
            ref = ref||0;
            var qos;
            if(typeof options == "object") {
                qos = options.qos;
            } else {
                qos = options;
                options = {};
            }
            options.qos = qos;
            if (!node.subscriptionIds[topic]) {
                node.subscriptionIds[topic] = node.subid++;
            }
            options.properties = options.properties || {};
            options.properties.subscriptionIdentifier = node.subscriptionIds[topic];

            node.subscriptions[topic] = node.subscriptions[topic]||{};
            var sub = {
                topic:topic,
                qos:qos,
                options:options,
                handler:function(mtopic,mpayload, mpacket) {
                    if(mpacket.properties && options.properties && mpacket.properties.subscriptionIdentifier && options.properties.subscriptionIdentifier && (mpacket.properties.subscriptionIdentifier !== options.properties.subscriptionIdentifier) ) {
                        //do nothing as subscriptionIdentifier does not match
                        // node.debug(`> no match - this nodes subID (${options.properties.subscriptionIdentifier}) !== packet subID (${mpacket.properties.subscriptionIdentifier})`); //TODO: remove
                    } else if (matchTopic(topic,mtopic)) {
                        // node.debug(`>  MATCHED '${topic}' to '${mtopic}' - performing callback`); //TODO: remove
                        callback(mtopic,mpayload, mpacket);
                    } else {
                        // node.debug(`> no match / no callback`); //TODO: remove
                    }
                },
                ref: ref
            };
            node.subscriptions[topic][ref] = sub;
            if (node.connected) {
                // node.debug(`this.subscribe - registering handler ref ${ref} for ${topic} and subscribing `+JSON.stringify(options)); //TODO: remove
                node.client.on('message',sub.handler);
                node.client.subscribe(topic, options);
            }
        };

        this.unsubscribe = function (topic, ref, removed) {
            ref = ref||0;
            var sub = node.subscriptions[topic];
            // var _debug = `unsubscribe for topic ${topic} called... ` ; //TODO: remove
            if (sub) {
                // _debug += "sub found. " //TODO: remove
                if (sub[ref]) {
                    // debug(`this.unsubscribe - removing handler ref ${ref} for ${topic} `); //TODO: remove
                    // _debug += `removing handler ref ${ref} for ${topic}. `
                    node.client.removeListener('message',sub[ref].handler);
                    delete sub[ref];
                }
                //TODO: Review. The `if(removed)` was commented out to always delete and remove subscriptions.
                // if we dont then property changes dont get applied and old subs still trigger
                //if (removed) {

                    if (Object.keys(sub).length === 0) {
                        delete node.subscriptions[topic];
                        delete node.subscriptionIds[topic];
                        if (node.connected) {
                            // _debug += `calling client.unsubscribe to remove topic ${topic}` //TODO: remove
                            node.client.unsubscribe(topic);
                        }
                    }
                //}
            } else {
                // _debug += "sub not found! "; //TODO: remove
            }
            // node.debug(_debug); //TODO: remove

        };
        this.topicAliases = {};

        this.publish = function (msg,done) {
            if (node.connected) {
                if (msg.payload === null || msg.payload === undefined) {
                    msg.payload = "";
                } else if (!Buffer.isBuffer(msg.payload)) {
                    if (typeof msg.payload === "object") {
                        msg.payload = JSON.stringify(msg.payload);
                    } else if (typeof msg.payload !== "string") {
                        msg.payload = "" + msg.payload;
                    }
                }
                var options = {
                    qos: msg.qos || 0,
                    retain: msg.retain || false
                };
                //https://github.com/mqttjs/MQTT.js/blob/master/README.md#mqttclientpublishtopic-message-options-callback
                if(node.options.protocolVersion == 5) {
                    options.properties = options.properties || {};
                    setStrProp(msg, options.properties, "responseTopic");
                    setBufferProp(msg, options.properties, "correlationData");
                    setStrProp(msg, options.properties, "contentType");
                    setIntProp(msg, options.properties, "messageExpiryInterval", 0);
                    setUserProperties(msg.userProperties, options.properties);
                    setIntProp(msg, options.properties, "topicAlias", 1, node.serverProperties.topicAliasMaximum || 0);
                    setBoolProp(msg, options.properties, "payloadFormatIndicator");
                    //FUTURE setIntProp(msg, options.properties, "subscriptionIdentifier", 1, 268435455);
                    if (options.properties.topicAlias) {
                        if (!node.topicAliases.hasOwnProperty(options.properties.topicAlias) && msg.topic == "") {
                            done("Invalid topicAlias");
                            return
                        }
                        if (node.topicAliases[options.properties.topicAlias] === msg.topic) {
                            msg.topic = ""
                        } else {
                            node.topicAliases[options.properties.topicAlias] = msg.topic
                        }
                    }
                }

                node.client.publish(msg.topic, msg.payload, options, function(err) {
                    done && done(err);
                    return
                });
            }
        };

        this.on('close', function(done) {
            this.closing = true;
            if (this.connected) {
                this.client.once('close', function() {
                    done();
                });
                this.client.end();
            } else if (this.connecting || node.client.reconnecting) {
                node.client.end();
                done();
            } else {
                done();
            }
        });

    }

    RED.nodes.registerType("mqtt-broker",MQTTBrokerNode,{
        credentials: {
            user: {type:"text"},
            password: {type: "password"}
        }
    });

    function MQTTInNode(n) {
        RED.nodes.createNode(this,n);
        this.topic = n.topic;
        this.qos = parseInt(n.qos);
        this.subscriptionIdentifier = n.subscriptionIdentifier;//https://docs.oasis-open.org/mqtt/mqtt/v5.0/os/mqtt-v5.0-os.html#_Toc3901117
        this.nl = n.nl;
        this.rap = n.rap;
        this.rh = n.rh;


        if (isNaN(this.qos) || this.qos < 0 || this.qos > 2) {
            this.qos = 2;
        }
        this.broker = n.broker;
        this.brokerConn = RED.nodes.getNode(this.broker);
        if (!/^(#$|(\+|[^+#]*)(\/(\+|[^+#]*))*(\/(\+|#|[^+#]*))?$)/.test(this.topic)) {
            return this.warn(RED._("mqtt.errors.invalid-topic"));
        }
        this.datatype = n.datatype || "utf8";
        var node = this;
        if (this.brokerConn) {
            let v5 = this.brokerConn.options && this.brokerConn.options.protocolVersion == 5;
            this.status({fill:"red",shape:"ring",text:"node-red:common.status.disconnected"});
            if (this.topic) {
                node.brokerConn.register(this);
                let options = { qos: this.qos };
                if(v5) {
                    // options.properties = {};
                    // if(node.userProperties) {
                    //     let userProperties = RED.util.evaluateNodeProperty(node.userProperties, node.userPropertiesType, node, {});
                    //     setUserProperties(userProperties, options.properties);
                    // }
                    // setIntProp(node,options.properties,"subscriptionIdentifier", 1);
                    setIntProp(node, options, "rh");
                    if(node.nl === "true" || node.nl === true) options.nl = true;
                    else if(node.nl === "false" || node.nl === false) options.nl = false;
                    if(node.rap === "true" || node.rap === true) options.rap = true;
                    else if(node.rap === "false" || node.rap === false) options.rap = false;
                }

                this.brokerConn.subscribe(this.topic,options,function(topic,payload,packet) {
                    // node.debug(`Sent ${topic}, datatype ${node.datatype} `+JSON.stringify(packet));//TODO: remove
                    if (node.datatype === "buffer") {
                        // payload = payload;
                    } else if (node.datatype === "base64") {
                        payload = payload.toString('base64');
                    } else if (node.datatype === "utf8") {
                        payload = payload.toString('utf8');
                    } else if (node.datatype === "json") {
                        if (isUtf8(payload)) {
                            payload = payload.toString();
                            try { payload = JSON.parse(payload); }
                            catch(e) { node.error(RED._("mqtt.errors.invalid-json-parse"),{payload:payload, topic:topic, qos:packet.qos, retain:packet.retain}); return; }
                        }
                        else { node.error((RED._("mqtt.errors.invalid-json-string")),{payload:payload, topic:topic, qos:packet.qos, retain:packet.retain}); return; }
                    } else {
                        if (isUtf8(payload)) { payload = payload.toString(); }
                    }
                    var msg = {topic:topic, payload:payload, qos:packet.qos, retain:packet.retain};
                    if(v5 && packet.properties) {
                        //msg.properties = packet.properties;
                        setStrProp(packet.properties, msg, "responseTopic");
                        setBufferProp(packet.properties, msg, "correlationData");
                        setStrProp(packet.properties, msg, "contentType");
                        // setIntProp(packet.properties, msg, "topicAlias", 1, node.brokerConn.serverProperties.topicAliasMaximum || 0);
                        // setIntProp(packet.properties, msg, "subscriptionIdentifier", 1, 268435455);
                        setIntProp(packet.properties, msg, "messageExpiryInterval", 0);
                        setBoolProp(packet.properties, msg, "payloadFormatIndicator");
                        setStrProp(packet.properties, msg, "reasonString");
                        setUserProperties(packet.properties.userProperties, msg);
                    }
                    if ((node.brokerConn.broker === "localhost")||(node.brokerConn.broker === "127.0.0.1")) {
                        msg._topic = topic;
                    }
                    node.send(msg);
                }, this.id);
                if (this.brokerConn.connected) {
                    node.status({fill:"green",shape:"dot",text:"node-red:common.status.connected"});
                }
            }
            else {
                this.error(RED._("mqtt.errors.not-defined"));
            }
            this.on('close', function(removed, done) {
                if (node.brokerConn) {
                    node.brokerConn.unsubscribe(node.topic,node.id, removed);
                    node.brokerConn.deregister(node,done);
                }
            });
        } else {
            this.error(RED._("mqtt.errors.missing-config"));
        }
    }
    RED.nodes.registerType("kbus in",MQTTInNode);

    function MQTTOutNode(n) {
        RED.nodes.createNode(this,n);
        this.topic = n.topic;
        this.qos = n.qos || null;
        this.retain = n.retain;
        this.broker = n.broker;
        this.responseTopic = n.respTopic;//https://docs.oasis-open.org/mqtt/mqtt/v5.0/os/mqtt-v5.0-os.html#_Toc3901114
        this.correlationData = n.correl;//https://docs.oasis-open.org/mqtt/mqtt/v5.0/os/mqtt-v5.0-os.html#_Toc3901115
        this.contentType = n.contentType;//https://docs.oasis-open.org/mqtt/mqtt/v5.0/os/mqtt-v5.0-os.html#_Toc3901118
        this.messageExpiryInterval = n.expiry; //https://docs.oasis-open.org/mqtt/mqtt/v5.0/os/mqtt-v5.0-os.html#_Toc3901112
        try {
            if (/^ *{/.test(n.userProps)) {
                //setup this.userProperties
                setUserProperties(JSON.parse(n.userProps), this);//https://docs.oasis-open.org/mqtt/mqtt/v5.0/os/mqtt-v5.0-os.html#_Toc3901116
            }
        } catch(err) {}
        // this.topicAlias = n.topicAlias; //https://docs.oasis-open.org/mqtt/mqtt/v5.0/os/mqtt-v5.0-os.html#_Toc3901113
        // this.payloadFormatIndicator = n.payloadFormatIndicator; //https://docs.oasis-open.org/mqtt/mqtt/v5.0/os/mqtt-v5.0-os.html#_Toc3901111
        // this.subscriptionIdentifier = n.subscriptionIdentifier;//https://docs.oasis-open.org/mqtt/mqtt/v5.0/os/mqtt-v5.0-os.html#_Toc3901117

        this.brokerConn = RED.nodes.getNode(this.broker);
        var node = this;
        var chk = /[\+#]/;

        if (this.brokerConn) {
            let v5 = this.brokerConn.options && this.brokerConn.options.protocolVersion == 5;
            this.status({fill:"red",shape:"ring",text:"node-red:common.status.disconnected"});
            this.on("input",function(msg,send,done) {
                if (msg.qos) {
                    msg.qos = parseInt(msg.qos);
                    if ((msg.qos !== 0) && (msg.qos !== 1) && (msg.qos !== 2)) {
                        msg.qos = null;
                    }
                }
                msg.qos = Number(node.qos || msg.qos || 0);
                msg.retain = node.retain || msg.retain || false;
                msg.retain = ((msg.retain === true) || (msg.retain === "true")) || false;
                /** If node property exists, override/set that to property in msg  */
                let msgPropOverride = function(propName) { if(node[propName]) { msg[propName] = node[propName]; } }
                msgPropOverride("topic");
                if(v5) {
                    if(node.userProperties) {
                        msg.userProperties = node.userProperties;
                    }
                    if(node.responseTopic) {
                        msg.responseTopic = node.responseTopic;
                    }
                    if(node.correlationData) {
                        msg.correlationData = node.correlationData;
                    }
                    if(node.contentType) {
                        msg.contentType = node.contentType;
                    }
                    if(node.messageExpiryInterval) {
                        msg.messageExpiryInterval = node.messageExpiryInterval;
                    }
                    //Next, update/override the msg.xxxx properties from node config
                    //TODO: Should we be expecting msg.properties.xxxx instead of msg.xxxx?
                    // setStrProp(node,msg,"responseTopic");
                    // setBufferProp(node,msg,"correlationData");
                    // setStrProp(node,msg,"contentType");
                    // setIntProp(node,msg,"messageExpiryInterval");
                    //FUTURE setStrProp(node,msg,"topicAlias");
                    //FUTURE setBoolProp(node,msg,"payloadFormatIndicator");
                    //FUTURE setIntProp(node,msg,"subscriptionIdentifier");
                }
                if (msg.userProperties && typeof msg.userProperties !== "object") {
                    delete msg.userProperties;
                }
                if (msg.hasOwnProperty("topicAlias") && !isNaN(msg.topicAlias) && (msg.topicAlias === 0 || node.brokerConn.serverProperties.topicAliasMaximum === 0 || msg.topicAlias > node.brokerConn.serverProperties.topicAliasMaximum)) {
                    delete msg.topicAlias;
                }

                if ( msg.hasOwnProperty("payload")) {
                    let topicOK = msg.hasOwnProperty("topic") && (typeof msg.topic === "string") && (msg.topic !== "");
                    if (!topicOK && v5) {
                        //NOTE: A value of 0 (in server props topicAliasMaximum) indicates that the Server does not accept any Topic Aliases on this connection
                        if (msg.hasOwnProperty("topicAlias") && !isNaN(msg.topicAlias) && msg.topicAlias >= 0 && node.brokerConn.serverProperties.topicAliasMaximum && node.brokerConn.serverProperties.topicAliasMaximum >= msg.topicAlias) {
                            topicOK = true;
                            msg.topic = ""; //must be empty string
                        } else if (msg.hasOwnProperty("responseTopic") && (typeof msg.responseTopic === "string") && (msg.responseTopic !== "")) {
                            //TODO: if topic is empty but responseTopic has a string value, use that instead. Is this desirable?
                            topicOK = true;
                            msg.topic = msg.responseTopic;
                            //TODO: delete msg.responseTopic - to prevent it being resent?
                        }
                    }
                    if (topicOK) { // topic must exist
                        // node.debug(`sending msg to ${msg.topic} `+JSON.stringify(msg));//TODO: remove
                        this.brokerConn.publish(msg, function(err) {
                            let args = arguments;
                            let l = args.length;
                            done(err);
                        });  // send the message
                    } else {
                        node.warn(RED._("mqtt.errors.invalid-topic"));
                        done();
                    }
                } else {
                    done();
                }
            });
            if (this.brokerConn.connected) {
                node.status({fill:"green",shape:"dot",text:"node-red:common.status.connected"});
            }
            node.brokerConn.register(node);
            this.on('close', function(done) {
                node.brokerConn.deregister(node,done);
            });
        } else {
            this.error(RED._("mqtt.errors.missing-config"));
        }
    }
    RED.nodes.registerType("kbus out",MQTTOutNode);
};