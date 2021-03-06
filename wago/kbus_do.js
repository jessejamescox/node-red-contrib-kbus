module.exports = function(RED) {
    "use strict";

    function digitalOutput(n) {
       RED.nodes.createNode(this,n);
       var node = this;
       var moduleNum = n.module
       var channelNum = n.channel

        this.on('input', function(msg) {
            //var inMsg = JSON.parse(msg.payload);
            var o = {};
            if (msg.payload === true || msg.payload === false)  {
                o = {payload: {module: moduleNum, channel: channelNum, value: msg.payload}};
                node.send(o);
            }
        });
    }
    RED.nodes.registerType("digital output",digitalOutput);
};
