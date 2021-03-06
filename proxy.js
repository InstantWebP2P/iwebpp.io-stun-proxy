// Copyright (c) 2013 Tom Zhou<appnet.link@gmail.com>

var eventEmitter = require('events').EventEmitter,
    util = require('util'),
    WEBPP = require('appnet.io'),
    SEP = WEBPP.SEP,
    vURL = WEBPP.vURL,
    URL = require('url'),
    NET = require('net'),
    httppProxy = require('httpp-proxy'),
    zlib = require('zlib'),
    Buffer = require('buffer').Buffer,
    Iconv = require('iconv-lite'),
    Jschardet = require('jschardet'),
    Connect = require('connect');


// helpers
function isLocalhost(host){
    return ((host === 'localhost') || (host === '127.0.0.1') ||
            (host === '0:0:0:0:0:0:0:1') || (host === '::1'));
}

// vHost-based STUN proxy vURL like sxxxp-vlocal.
// TBD... chained proxy
///var vsperegex    = /s([0-9]|[a-f]){32}p/gi;
var vhostspregex = /(s([0-9]|[a-f]){32}p-)*vlocal\./gi;

// vPath-based STUN proxy vURL like /vlocal-sxxxp
///var vpathspregex = /\/vlocal(-s([0-9]|[a-f]){32}p)*/gi;

// Debug level
var Debug = 0;

// Proxy class
// a proxy will contain one appnet.io name-client
// - options: user custom parameters, like {secmode: ..., usrkey: ..., domain: ..., endpoints: ..., turn: ...}
// - options.secmode: ssl, enable ssl/https; acl, enable ssl/https,host-based ACL
// - options.https: true or false, true for https proxy server, false for http proxy server
// -      fn: callback to pass proxy informations
var Proxy = module.exports = function(options, fn){ 
    var self = this;
       
    if (!(this instanceof Proxy)) return new Proxy(options, fn);
    
    // super constructor
    eventEmitter.call(self);
    
    if (typeof options == 'function') {
        fn = options;
        options = {};
    }
    options.https = options.https || true;
        
    // 0.
	// proxy cache
    self.webProxyCache = self.webProxyCache || {};

    // 1.
    // create name client
    var nmcln = self.nmcln = new WEBPP({
        usrinfo: {
            domain: (options && options.domain) || '51dese.com',
            usrkey: (options && options.usrkey) || ('stun-proxy@'+Date.now())
        },
        
        srvinfo: {
            timeout: 20,
            endpoints: (options && options.endpoints) || [
                {ip: '51dese.com', port: 51686},
                {ip: '51dese.com', port: 51868}
            ],
            turn: (options && options.turn) || [
                {ip: '51dese.com', agent: 51866, proxy: 51688}
            ]
        },
        
        // vURL mode: vpath-based
		vmode: vURL.URL_MODE_PATH, 
        
        // secure mode
        secmode: (options && options.secmode === 'ssl') ? SEP.SEP_SEC_SSL : SEP.SEP_SEC_SSL_ACL_HOST
    });
	
	// 2.
	// check ready
	nmcln.once('ready', function(){
	    // http proxy
	    function httpxy(req, res, next) {
		    var vurle, vstrs, hoste = req.headers.host, urle = req.url;
		    
		    // 1.
		    // match vURL pattern:
		    // - vhost like http(s)://"xxx.vurl."vlocal.51dese.com
		    // - vpath like http(s)://vlocal.51dese.com"/vurl/xxx"
		    if (vstrs = req.headers.host.match(vURL.regex_vhost)) {
		        vurle = vstrs[0];
		        if (Debug) console.log('proxy for client with vhost:'+vurle);
		    } else if (vstrs = req.url.match(vURL.regex_vpath)) {
			    vurle = vstrs[0];	       
			    
			    // prune vpath in req.url
	            req.url = req.url.replace(vurle, '');
	            
	            // prune /vlocal/sxxxp path
	            // TBD ... cascade routing
	            ///req.url = req.url.replace(vpathspregex, '');
			         
			    if (Debug) console.log('proxy for client with vpath:'+vurle);
		    } else {
		        // invalid vURL
	            console.error('invalid URL:'+urle);
	            next();
	            
	            return;
		    }
	
		    if (Debug) console.log('Http request proxy for client request.headers:'+JSON.stringify(req.headers)+
		                           ',url:'+urle+',vurl:'+vurle);
		     
		    // 1.1
		    // check vURL if STUNable
		    // TBD ...
		                           
		    // 1.2
	        // !!! rewrite req.url to remove vToken parts
	        // TBD ... vToken check
	        req.url = req.url.replace(vURL.regex_vtoken, '');         
	        
	        // 1.3
            // remove vlocal. subdomain
            req.headers.host = req.headers.host.replace(vhostspregex, '');
		    
		    // 2.
			// get peer info by vURL
		    nmcln.getvURLInfo(vurle, function(err, routing){
		        // 2.1
		        // check error and authentication 
		        if (err || !routing) {
		            // invalid vURL
	                res.writeHead(400);
	                res.end('invalid URL');
	                console.error('invalid URL:'+urle);
	                
	                // invalide proxy cache
	                if (self.webProxyCache[vurle]) 
	                    self.webProxyCache[vurle] = null;
	                
	                return;
		        } else {
			        // 3.
			        // create proxy instance and cache it
			        if (!self.webProxyCache[vurle]) {
		                // fill routing info and create proxy to peer target
		                var dstip, dstport;
		                
		                if ((nmcln.oipaddr === routing.dst.ipaddr) ||
		                    (isLocalhost(nmcln.oipaddr) && isLocalhost(routing.dst.ipaddr))) {
		                    dstip   = routing.dst.lipaddr;
		                    dstport = routing.dst.lport;
		                } else {
		                    dstip   = routing.dst.ipaddr;
		                    dstport = routing.dst.port;
		                }
		                
			            self.webProxyCache[vurle] = new httppProxy.HttpProxy({
			                       https: options.https || false,
			                changeOrigin: false,
		                          enable: {xforward: true},
			                  
			                target: {
			                    httpp: true,
			                    
			                    // set SSL related info
			                    https: routing.secmode ? {
	                                rejectUnauthorized: nmcln.secerts && nmcln.secerts.rejectUnauthorized, 
	                                                ca: nmcln.secerts && nmcln.secerts.ca, 
	                                               key: nmcln.secerts && nmcln.secerts.key,
	                                              cert: nmcln.secerts && nmcln.secerts.cert
	                            } : false, 
			                    
			                    host: dstip,
			                    port: dstport,
			                    
			                    // set user-specific feature,like maxim bandwidth,etc
			                    localAddress: {
			                        addr: nmcln.ipaddr,
			                        port: nmcln.port, 
			                        
			                        opt: {
			                            mbw: options.mbw || null
			                        }
			                    }
			                }
			            });
			            
					    // 3.1
					    // Handle request error
					    self.webProxyCache[vurle].on('proxyError', function(err, req, res){
					        if (Debug) console.error(err+',proxy to '+urle);
					        
					        // send error back
					        try {
					            res.writeHead(500, {'Content-Type': 'text/plain'});
							    if (req.method !== 'HEAD') {
						            if (process.env.NODE_ENV === 'production') {
						                res.write('Internal Server Error');
						            } else {
						                res.write('An error has occurred: ' + JSON.stringify(err));
						            }
						        }
					            res.end();
					        } catch (ex) {
					            console.error("res.end error: %s", ex.message) ;
					        }
					        
		                    // clear vURL entry
		                    self.webProxyCache[vurle] = null;
		                });
		                
		                // 3.2
		                // Handle upgrade error
					    self.webProxyCache[vurle].on('webSocketProxyError', function(err, req, socket, head){
					        if (Debug) console.error(err+',proxy to '+urle);
					        
					        // send error back
					        try {
					            if (process.env.NODE_ENV === 'production') {
					                socket.write('Internal Server Error');
					            } else {
					                socket.write('An error has occurred: ' + JSON.stringify(err));
					            }
					            socket.end();
					        } catch (ex) {
					            console.error("socket.end error: %s", ex.message) ;
					        }
					        
					        // clear vURL entry
		                    self.webProxyCache[vurle] = null;
		                });
		                
					    // Handle custom rewrite logics on response for reverse proxy
					    //--> custom rewrite logics ///////////////////////////////////////
					    self.webProxyCache[vurle].on('proxyResponse', function(req, res, response){
					        var prxself = this;
					        if (Debug) console.log('Proxy response,'+'req.headers:'+JSON.stringify(req.headers)+
					                               '\n\n,response.statusCode:'+response.statusCode+',response.headers:'+JSON.stringify(response.headers));
					        
					        // 3.3
					        // rewrite href from 2XX text/html response for whole website proxy
					        if ((response.statusCode >= 200 && response.statusCode < 300) && 
					            ('content-type' in response.headers) && 
					            (response.headers['content-type'].match('text/html') ||
					             response.headers['content-type'].match('text/xml'))) {
					            if (Debug) console.log('Proxy 200 response,'+'response.headers:'+JSON.stringify(response.headers));
								            
					            // 3.3.0
					            // rewrite Content-Location in response
					            if (response.headers['content-location']) {           
			                        // - rewrite vhref host part by embedded 'sxxxp.vlocal.'
			                        // - rewrite vhref path part by embedded '/vlocal/sxxxp'
			                        response.headers['content-location'] = response.headers['content-location'].replace(vURL.regex_url, function(href){
			                            if (href.match(vURL.regex_vhost) && !(href.match(vhostspregex))) {
			                                // calculate replaced string
			                                return href.replace(vURL.regex_vhost, function(vhost){
			                                    ///var vhoste = vhost.match(vURL.regex_vurle)[0];
			                                    
			                                    ///return vhost+'s'+vhoste+'p'+'.vlocal.';
			                                    return vhost+'vlocal.';
			                                });
			                            } else if (href.match(vURL.regex_vpath) /*&& !(href.match(vpathspregex))*/) {
			                                // append vlocal. subdomain
			                                if (!(/^(https?:\/\/vlocal\.)/gi).test(href)) {
			                                    href = href.replace(/^(https?:\/\/)/gi, href.match(/^(https?:\/\/)/gi)[0]+'vlocal.');
			                                } 
			                                return href;
			                                
			                                // calculate replaced string
			                                /*
			                                return href.replace(vURL.regex_vpath, function(vpath){
			                                    var vpathe = vpath.match(vURL.regex_vurle)[0];
			                                    
			                                    return vpath+'/vlocal/'+'s'+vpathe+'p';
			                                });*/
			                            } else {
			                                return href;
			                            }
			                        });
					            }
					            	               
					            // 3.3.1
					            // intercept res.writeHead, res.write and res.end 
					            // notes:
					            // - unzip and zip again
					            // - ...
					            var reshed = {};
					            var resbuf = [];
					            var ressiz = 0;
					            var resstr = '';
					            var _res_write = res.write, _res_end = res.end, _res_writeHead = res.writeHead;
					            var _decomp, _encomp, _codec;
					            
					            // 3.1.1
					            // overwrite res.writeHead by cache statusCode
				                res.writeHead = function(statusCode, reasonPhrase, headers) {
				                    reshed.statusCode = statusCode;
				                    reshed.headers = {};
				                    
				                    if (typeof reasonPhrase === 'object') {
				                        reshed.headers = reasonPhrase;
				                    } else if (typeof headers === 'object') {
				                        reshed.headers = headers;
				                    }
				                    
				                    Object.keys(reshed.headers).forEach(function (key) {
								        res.setHeader(key, reshed.headers[key]);
								    });
				                };
	                
					            // 3.3.2
					            // handle compressed text
					            if (('content-encoding' in response.headers) &&
					                (response.headers['content-encoding'].match('gzip') ||
					                 response.headers['content-encoding'].match('deflate'))) {
					                if (Debug) console.log('Proxy ziped response,'+'response.headers:'+JSON.stringify(response.headers));
					                 
					                if (response.headers['content-encoding'].match('gzip')) {
					                    _codec  = 'gzip';
					                    _decomp = zlib.createGunzip();
					                    _encomp = zlib.createGzip();
					                } else {
					                    _codec  = 'deflate';
					                    _decomp = zlib.createInflate();
					                    _encomp = zlib.createDeflate();
					                }
					               	                
					                if (Debug) console.log('\n\ngzip');
					                
				                    // 3.3.2.1
				                    // override res.write and res.end
					                res.write = function(trunk){
					                    return _decomp.write(trunk);
					                };
					                res.end = function(trunk){
					                    _decomp.end(trunk);
					                };
					                
				                    // 3.3.3
				                    // in case handle Node.js-not-supported charset
				                    // - detect charset
					                // - decode content by charset 
					                // - rewrite resstr
					                // - send rewrote resstr by charset
					                // - force response on utf-8 charset??? TBD...
					               				                	                    
					                _decomp.on('data', function(text) {
				                        if (text) {
						                    resbuf.push(text);
						                    ressiz += text.length;
						                }
				                    });
				                    _decomp.on('end', function() {		
				                    	// 3.3.3.1
						                // concat big buffer
						                var bigbuf = Buffer.concat(resbuf, ressiz);
						                
						                // 3.3.3.2
						                // detect charset
						                var chardet = Jschardet.detect(bigbuf);
						                var charset = chardet.encoding;
						                
						                if (Debug) console.log('charset:'+JSON.stringify(chardet));
						                		                
						                // 3.3.3.3
						                // decode content by charset
						                resstr = Iconv.decode(bigbuf, charset);
						                                
				                        if (Debug > 1) console.log('text response:'+resstr);
				                        
				                        // 3.3.3.4
				                        // rewrite text content            
				                        ///console.log('before rewrite:'+JSON.stringify(resstr.match(vURL.regex_url)));
				                        									
				                        // 3.3.3.4.1
				                        // - rewrite vhref host part by embedded 'sxxxp.vlocal.'
				                        // - rewrite vhref path part by embedded '/vlocal/sxxxp'
				                        resstr = resstr.replace(vURL.regex_url, function(href){
				                            if (href.match(vURL.regex_vhost) && !(href.match(vhostspregex))) {
				                                // calculate replaced string
				                                return href.replace(vURL.regex_vhost, function(vhost){
				                                    ///var vhoste = vhost.match(vURL.regex_vurle)[0];
				                                    
				                                    ///return vhost+'s'+vhoste+'p'+'.vlocal.';
				                                    return vhost+'vlocal.';
				                                });
				                            } else if (href.match(vURL.regex_vpath) /*&& !(href.match(vpathspregex))*/) {
				                                // append vlocal. subdomain
				                                if (!(/^(https?:\/\/vlocal\.)/gi).test(href)) {
				                                    href = href.replace(/^(https?:\/\/)/gi, href.match(/^(https?:\/\/)/gi)[0]+'vlocal.');
				                                }
				                                return href;
				                                
				                                // calculate replaced string
				                                /*return href.replace(vURL.regex_vpath, function(vpath){
				                                    var vpathe = vpath.match(vURL.regex_vurle)[0];
				                                    
				                                    return vpath+'/vlocal/'+'s'+vpathe+'p';
				                                });*/
				                            } else {
				                                return href;
				                            }
				                        });
				                        			                        
				                        ///console.log('after rewrite:'+JSON.stringify(resstr.match(vURL.regex_url)));
						                if (Debug > 1) console.log('overwrote text response:'+resstr);
				                        
				                        // 3.3.3.5
				                        // compress overwrote text and send out
				                        if (_codec === 'gzip') {
				                            var encbuf = Iconv.encode(resstr, charset);
	                            
				                            // rewrite content-length
				                            res.setHeader('content-length', encbuf.length);
				                            res.writeHead = _res_writeHead;
				                            res.writeHead(reshed.statusCode || 200);
				                            
				                            zlib.gzip(encbuf, function(err, buffer) {
				                                if (err) {
				                                    console.log(err+',deflate failed');
				                                    res.emit('error', err+',gzip failed');
				                                } else {
													res.write = _res_write;
													res.end = _res_end;
													
													res.end(buffer);
				                                }
				                            });
				                        } else {
				                            var encbuf = Iconv.encode(resstr, charset);
				                            
				                            // rewrite content-length
				                            res.setHeader('content-length', encbuf.length);
				                            res.writeHead = _res_writeHead;
				                            res.writeHead(reshed.statusCode || 200);
				                            
				                            zlib.deflate(encbuf, function(err, buffer) {
				                                if (!err) {
				                                    console.log(err+',deflate failed');
				                                    res.emit('error', err+',deflate failed');
				                                } else {
													res.write = _res_write;
													res.end = _res_end;
													
													res.end(buffer);
				                                }
				                            });                        
				                        }
				                    });
				                    
				                    // 3.3.4
				                    // decompress data 
				                    _decomp.on('drain', function(){
				                        res.emit('drain');
				                    });
					            } else {
					                if (Debug) console.log('\n\nnotzip');
					                
					                // 3.3.5
					                // in case handle Node.js-not-supported charset
				                    // - detect charset
					                // - decode content by charset 
					                // - rewrite resstr
					                // - send rewrote by charset
					                // - force response on utf-8 charset??? TBD...
					                
					                // 3.3.5.1
				                    // override res.write and res.end         
						            res.write = function(text){
						                if (text) {
						                    resbuf.push(text);
						                    ressiz += text.length;
						                }
						                return true;
						            };
						            res.end = function(text){
						                if (text) {
						                    resbuf.push(text);
						                    ressiz += text.length;
						                }
						                
						                // 3.3.5.2
						                // concat big buffer
						                var bigbuf = Buffer.concat(resbuf, ressiz);
						                
						                // 3.3.5.3
						                // detect charset
						                var chardet = Jschardet.detect(bigbuf);
						                var charset = chardet.encoding;
						                
						                if (Debug) console.log('charset:'+JSON.stringify(chardet));
						                		                
						                // 3.3.5.4
						                // decode content by charset
						                resstr = Iconv.decode(bigbuf, charset);
						                
						                if (Debug > 1) console.log('text response:'+resstr);
						                
				                        // 3.3.5.5
				                        // rewrite text content
				                        ///console.log('before rewrite:'+JSON.stringify(resstr.match(vURL.regex_url)));
				                        									
				                        // 3.3.5.5.1
				                        // - rewrite vhref host part by embedded 'sxxxp.vlocal.'
				                        // - rewrite vhref path part by embedded '/vlocal/sxxxp'
				                        resstr = resstr.replace(vURL.regex_url, function(href){
				                            if (href.match(vURL.regex_vhost) && !(href.match(vhostspregex))) {
				                                // calculate replaced string
				                                return href.replace(vURL.regex_vhost,  function(vhost){
				                                    ///var vhoste = vhost.match(vURL.regex_vurle)[0];
				                                    
				                                    ///return vhost+'s'+vhoste+'p'+'.vlocal.';
				                                    return vhost+'vlocal.';
				                                });
				                            } else if (href.match(vURL.regex_vpath) /*&& !(href.match(vpathspregex))*/) {
				                                // append vlocal. subdomain
				                                if (!(/^(https?:\/\/vlocal\.)/gi).test(href)) {
				                                    href = href.replace(/^(https?:\/\/)/gi, href.match(/^(https?:\/\/)/gi)[0]+'vlocal.');
				                                }
				                                return href;
				                                
				                                // calculate replaced string
				                                /*return href.replace(vURL.regex_vpath, function(vpath){
				                                    var vpathe = vpath.match(vURL.regex_vurle)[0];
				                                    
				                                    return vpath+'/vlocal/'+'s'+vpathe+'p';
				                                });*/
				                            } else {
				                                return href;
				                            }
				                        });
				                        			                        
				                        ///console.log('after rewrite:'+JSON.stringify(resstr.match(vURL.regex_url)));
						                if (Debug > 1) console.log('overwrote text response:'+resstr);
				                        
				                        // 3.3.6
				                        // send overwrote text out
										res.write = _res_write;
										res.end = _res_end;
										
										var encbuf = Iconv.encode(resstr, charset);
							
							            // rewrite content-length
				                        res.setHeader('content-length', encbuf.length);
				                        res.writeHead = _res_writeHead;
				                        res.writeHead(reshed.statusCode || 200);
				                        
										res.end(encbuf);
						            };
					            }
					        }
					        
					        // 3.4.
					        // ...
					        
					        // 3.5.
					        // rewrite 3XX redirection location by embedded 'sxxxp.vlocal.'			    
						    if ((response.statusCode >= 300 && response.statusCode < 400) &&
						         typeof response.headers.location !== 'undefined') {					          
					            response.headers.location = response.headers.location.replace(vURL.regex_url, function(href){
		                            if (href.match(vURL.regex_vhost) && !(href.match(vhostspregex))) {
		                                // calculate replaced string
		                                return href.replace(vURL.regex_vhost, function(vhost){
		                                    ///var vhoste = vhost.match(vURL.regex_vurle)[0];
		                                    
		                                    ///return vhost+'s'+vhoste+'p'+'.vlocal.';
		                                    return vhost+'vlocal.';
		                                });
		                            } else if (href.match(vURL.regex_vpath) /*&& !(href.match(vpathspregex))*/) {
		                                // append vlocal. subdomain
		                                if (!(/^(https?:\/\/vlocal\.)/gi).test(href)) {
		                                    href = href.replace(/^(https?:\/\/)/gi, href.match(/^(https?:\/\/)/gi)[0]+'vlocal.');
		                                } 
		                                return href;
		                                
		                                // calculate replaced string
		                                /*return href.replace(vURL.regex_vpath, function(vpath){
		                                    var vpathe = vpath.match(vURL.regex_vurle)[0];
		                                    
		                                    return vpath+'/vlocal/'+'s'+vpathe+'p';
		                                });*/
				                    } else {
		                                return href;
		                            }
		                        });
						    }
					    });
					    //<-- custom rewrite logics ///////////////////////////////////////
			        }
			        
			        // 5.
			        // traverse STUN session to peer
			        nmcln.trvsSTUN(vurle, function(err, stun){
			            if (err || !stun) {
				            // STUN not available, fall back to TURN
		                    /*res.writeHead(400);
		                    res.end('STUN not available, please use TURN');
		                    console.error('STUN not available:'+urle);*/
                            res.writeHead(301, {'location': 'https://'+hoste.replace('vlocal.', '')+urle});
						    res.end();
                            console.log('fall back to TURN');
			            } else {
			                // 6.
						    // proxy target
					        // work-around first STUN setup hang by redirect 
						    if (stun.firstrun) {
						        res.writeHead(301, {'location': urle});
						        res.end();
					        } else {
					            self.webProxyCache[vurle].proxyRequest(req, res);
					        }
			            }
			        });
		        }
	        });
	    }
	    
	    // create connect App 
	    var appHttp = Connect();
		
	    // hook http proxy
	    appHttp.use(httpxy);
		
	    // hook portal page
	    // TBD...
	    
	    // websocket proxy
	    function wspxy(req, socket, head) {
		    var vurle, vstrs, hoste = req.headers.host, urle = req.url;
		    
		    // 1.
		    // match vURL pattern:
		    // - vhost like http(s)://"xxx.vurl."vlocal.51dese.com
		    // - vpath like http(s)://vlocal.51dese.com"/vurl/xxx"
		    if (vstrs = req.headers.host.match(vURL.regex_vhost)) {
		        vurle = vstrs[0];
		        if (Debug) console.log('proxy for client with vhost:'+vurle);
		    } else if (vstrs = req.url.match(vURL.regex_vpath)) {
			    vurle = vstrs[0];	       
			    
			    // prune vpath in req.url
	            req.url = req.url.replace(vurle, '');
			    
			    // prune /vlocal/sxxxp path
	            // TBD ... cascade routing
	            ///req.url = req.url.replace(vpathspregex, '');
	                 
			    if (Debug) console.log('proxy for client with vpath:'+vurle);
		    } else {
		        // invalid vURL
	            // MUST not close socket, which will break other upgrade listener
	            console.error('invalid URL:'+urle);
	            return;
		    }
		    
		    if (Debug) console.log('Http request proxy for client request.headers:'+JSON.stringify(req.headers)+
		                           ',url:'+urle+',vurl:'+vurle);

		    // 1.1
		    // check vURL if STUNable
		    // TBD ...
		    		                           
		    // 1.2
	        // !!! rewrite req.url to remove vToken parts
	        // TBD ... vToken check
	        req.url = req.url.replace(vURL.regex_vtoken, '');
	                              
	        // 1.3
            // remove vlocal. subdomain
            req.headers.host = req.headers.host.replace(vhostspregex, '');
		    
		    // 2.
			// get peer info by vURL
		    nmcln.getvURLInfo(vurle, function(err, routing){
		        // 2.1
		        // check error and authentication 
		        if (err || !routing) {
		            // invalid vURL
	                socket.end('invalid URL');
	                console.error('invalid URL:'+urle);
	                
	                // invalide proxy cache
	                if (self.webProxyCache[vurle]) 
	                    self.webProxyCache[vurle] = null;
	                
	                return;
		        } else {
			        // 3.
			        // create proxy instance and cache it
			        if (!self.webProxyCache[vurle]) {
		                // fill routing info and create proxy to peer target
		                var dstip, dstport;
		                
		                if ((nmcln.oipaddr === routing.dst.ipaddr) || 
		                    (isLocalhost(nmcln.oipaddr) && isLocalhost(routing.dst.ipaddr))) {
		                    dstip   = routing.dst.lipaddr;
		                    dstport = routing.dst.lport;
		                } else {
		                    dstip   = routing.dst.ipaddr;
		                    dstport = routing.dst.port;
		                }
		                
			            self.webProxyCache[vurle] = new httppProxy.HttpProxy({
			                       https: options.https || false,
			                changeOrigin: false,
		                          enable: {xforward: true},
			                  
			                target: {
			                    httpp: true,
			                    
			                    // set SSL related info
			                    https: routing.secmode ? {
	                                rejectUnauthorized: nmcln.secerts && nmcln.secerts.rejectUnauthorized, 
	                                                ca: nmcln.secerts && nmcln.secerts.ca, 
	                                               key: nmcln.secerts && nmcln.secerts.key,
	                                              cert: nmcln.secerts && nmcln.secerts.cert
	                            } : false, 
			                    
			                    host: dstip,
			                    port: dstport,
			                    
			                    // set user-specific feature,like maxim bandwidth,etc
			                    localAddress: {
			                        addr: nmcln.ipaddr,
			                        port: nmcln.port, 
			                        
			                        opt: {
			                            mbw: options.mbw || null
			                        }
			                    }
			                }
			            });
			            
					    // Handle request error
					    self.webProxyCache[vurle].on('proxyError', function(err, req, res){
					        if (Debug) console.error(err+',proxy to '+urle);
					        
					        // send error back
					        try {
					            res.writeHead(500, {'Content-Type': 'text/plain'});
							    if (req.method !== 'HEAD') {
						            if (process.env.NODE_ENV === 'production') {
						                res.write('Internal Server Error');
						            } else {
						                res.write('An error has occurred: ' + JSON.stringify(err));
						            }
						        }
					            res.end();
					        } catch (ex) {
					            console.error("res.end error: %s", ex.message) ;
					        }
					        
		                    // clear vURL entry
		                    self.webProxyCache[vurle] = null;
		                });
		                
		                // Handle upgrade error
					    self.webProxyCache[vurle].on('webSocketProxyError', function(err, req, socket, head){
					        if (Debug) console.error(err+',proxy to '+urle);
					        
					        // send error back
					        try {
					            if (process.env.NODE_ENV === 'production') {
					                socket.write('Internal Server Error');
					            } else {
					                socket.write('An error has occurred: ' + JSON.stringify(err));
					            }
					            socket.end();
					        } catch (ex) {
					            console.error("socket.end error: %s", ex.message) ;
					        }
					        
					        // clear vURL entry
		                    self.webProxyCache[vurle] = null;
		                });
		                
		                // 
			        }
			        		    
			        // 5.
			        // traverse STUN session to peer
                    // notes: the step may needless because http proxy should did it
			        nmcln.trvsSTUN(vurle, function(err, stun){
			            if (err || !stun) {
				            // STUN not available, try to fall back to TURN
		                    socket.end('STUN not available, please use TURN');
		                    console.error('STUN not available:'+urle);
			            } else {
			                // 6.
						    // proxy target
					        self.webProxyCache[vurle].proxyWebSocketRequest(req, socket, head);
			            }
			        });		        
		        }
	        });
	    }
    
        // 8.
	    // pass STUN proxy App
	    var papps = {httpApp: appHttp, wsApp: wspxy};
	    if (fn) fn(null, papps);
	    self.emit('ready', papps);
	});
	
	// 1.2
	// check error
	nmcln.on('error', function(err){
	    console.log('name-client create failed:'+JSON.stringify(err));
	    if (fn) fn(err);
	    self.emit('error', err);
	});
};

util.inherits(Proxy, eventEmitter);

