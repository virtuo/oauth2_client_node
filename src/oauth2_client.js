/* 
 * OAuth2 client module, defining:
 *  - a connect middleware, that allows your application to act as a OAuth2
 *    client.
 *  - the method redirects_for_login (connector method must have been called 
 *    before), that redirects the user to the OAuth2 server for authentication.
 *
 */
require.paths.unshift(__dirname + '/../vendors/node-base64');

var URL = require('url')
  , querystring = require('querystring')

  , base64 = require('base64')
  , web = require('nodetk/web')
  , tools = require('nodetk/server_tools')
  ;

var CLIENT = exports;

CLIENT.dumps = function(obj) {
  /* Crypt the JSON object to opaque string
   */
  // TODO: crypt the string
  return base64.encode(JSON.stringify(obj));
};

CLIENT.loads = function(str) {
  /* Uncrypt the string and return JSON obj or null.
   */
  if(!str) return null;
  try {
    return JSON.parse(base64.decode(str));
  } catch(err) {
    return null;
  }
};


CLIENT.transform_token_response = function(body) {
  /* Given body answer to the HTTP request to obtain the access_token, 
   * returns a JSON hash containing:
   *  - access_token
   *  - expires_in (optional)
   *  - refresh_token (optional)
   *
   * If no access_token in there, return null;
   *
   */
  return JSON.parse(body)
};

CLIENT.valid_grant = function(oauth2_server_id, code, callback, fallback) {
  /* Valid the grant given by user requesting the OAuth2 server 
   * at OAuth2 token endpoint.
   *
   * Arguments:
   *    - oauth2_server_id: the OAuth2 server (ex: "facebook.com").
   *    - code: the authorization code given by OAuth2 server to user.
   *    - callback: function to be called once grant is validated/rejected.
   *      Called with the access_token returned by OAuth2 server as first
   *      parameter. If given token might be null, meaning it was rejected
   *      by OAuth2 server.
   *    - fallback: function to be called in case of error, with err argument.
   *
   */
  var cconfig = CLIENT.config.client;
  var sconfig = CLIENT.config.servers[oauth2_server_id];
  web.POST(sconfig.server_token_endpoint, {
    grant_type: "authorization_code",
    client_id: sconfig.client_id,
    code: code,
    client_secret: sconfig.client_secret,
    redirect_uri: cconfig.redirect_uri
  }, function(statusCode, headers, body) {
    if(statusCode == 200) {
      try {
        var token = CLIENT.transform_token_response(body)
        callback(token);
      } catch(err) {
        fallback(err);
      }
    }
    else callback(null);
    // TODO: check if error code indicates problem on the client,
    // and if so, calls fallback(err) instead of callback(null).
  });
};


CLIENT.treat_access_token = function(access_token, req, res, callback, fallback) {
  /* Make something with the access_token.
   *
   * This is the default implementation provided by this client.
   * This implementation does nothing, and the exact way this access_token
   * should be used is not specified by the OAuth2 spec (only how it should
   * be passed to resource provider).
   *
   * Arguments:
   *  - access_token: the access_token returned by the server.
   *  - req
   *  - res
   *  - callback: to be called when action is done. The request will be blocked
   *    while this callback has not been called (so that the session can be
   *    updated...).
   *
   */
  callback();
};


CLIENT.auth_process_login = function(req, res) {
  /* Check the grant given by user to login in authserver is a good one.
   *
   * Arguments:
   *  - req
   *  - res
   */
  var params = URL.parse(req.url, true).query || {}
    , code = params.code
    , state = params.state
    ;

  if(!code) {
    res.writeHead(400, {'Content-Type': 'text/plain'});
    return res.end('The "code" parameter is missing.');
  }
  if(!state) {
    res.writeHead(400, {'Content-Type': 'text/plain'});
    return res.end('The "state" parameter is missing.');
  }
  state = CLIENT.loads(state);
  if(!state) {
    res.writeHead(400, {'Content-Type': 'text/plain'});
    return res.end('The "state" parameter is invalid.');
  }
  var oauth2_server_id = state[0];
  var next_url = state[1];
  state = state[2]; // TODO: do something with it!
  CLIENT.valid_grant(oauth2_server_id, code, function(token) {
    if(!token) {
      res.writeHead(400, {'Content-Type': 'text/plain'});
      res.end('Invalid grant.');
      return;
    }
    CLIENT.treat_access_token(token.access_token, req, res, function() {
      tools.redirect(res, next_url);
    }, function(err){tools.server_error(res, err)});
  }, function(err){tools.server_error(res, err)});
};


CLIENT.redirects_for_login = function(oauth2_server_id, res, next_url, state) {
  /* Redirects the user to OAuth2 server for authentication.
   *
   * Arguments:
   *  - oauth2_server_id: OAuth2 server identification (ex: "facebook.com").
   *  - res
   *  - next_url: an url to redirect to once the process is complete.
   *  - state: optional, a hash containing info you want to retrieve at the end
   *    of the process.
   */
  var sconfig = CLIENT.config.servers[oauth2_server_id];
  var cconfig = CLIENT.config.client;
  var data = {
    client_id: sconfig.client_id,
    redirect_uri: cconfig.redirect_uri,
    response_type: 'code',
    state: CLIENT.dumps([oauth2_server_id, next_url, state || null])
  };
  var url = sconfig.server_authorize_endpoint +'?'+ querystring.stringify(data);
  tools.redirect(res, url);
};

CLIENT.nexturl_query = function(req) {
  /* Returns value of next url query parameter if present, default otherwise.
   * The next query parameter should not contain the domain, the result will.
   */
  var cconfig = CLIENT.config.client;
  var params = URL.parse(req.url, true).query || {};
  var next = params.next || cconfig.default_redirection_url;
  var url = cconfig.base_url + next;
  return url;
};

var logout = function(req, res) {
  /* Logout the eventual logged in user.
   */
  req.session = {};
  tools.redirect(res, CLIENT.nexturl_query(req));
};

var login = function(req, res) {
  /* Triggers redirects_for_login with next param if present in url query.
   */
  var oauth2_server_id = CLIENT.config.default_server;
  CLIENT.redirects_for_login(oauth2_server_id, res, CLIENT.nexturl_query(req));
};

exports.connector = function(conf, options) {
  /* Returns OAuth2 client connect middleware.
   *
   * This middleware will intercep requests aiming at OAuth2 client
   * and treat them.
   *
   * Arguments:
   *  - config: hash containing:
   *
   *    - client, hash containing:
   *      - base_url: The base URL of the OAuth2 client. 
   *        Ex: http://domain.com:8080
   *      - process_login_url: the URL where to the OAuth2 server must redirect
   *        the user when authenticated.
   *      - login_url: the URL where the user must go to be redirected
   *        to OAuth2 server for authentication.
   *      - logout_url: the URL where the user must go so that his session is
   *        cleared, and he is unlogged from client.
   *      - default_redirection_url: default URL to redirect to after login / logout.
   *        Optional, default to '/'.
   *
   *    - default_server: which server to use for default login when user
   *      access login_url (ex: 'facebook.com').
   *    - servers: hash associating an OAuth2 server ids (ex: "facebook.com") 
   *      with a hash containing (for each):
   *      - server_authorize_endpoint: full URL, OAuth2 server token endpoint
   *        (ex: "https://graph.facebook.com/oauth/authorize").
   *      - server_token_endpoint: full url, where to check the token
   *        (ex: "https://graph.facebook.com/oauth/access_token").
   *      - client_id: the client id as registered by this OAuth2 server.
   *      - client_secret: shared secret between client and this OAuth2 server.
   *
   *  - options: optional, hash containing:
   *    - valid_grant: a function which will replace the default one
   *      to check the grant is ok. You might want to use this shortcut if you
   *      have a faster way of checking than requesting the OAuth2 server
   *      with an HTTP request.
   *    - treat_access_token: a function which will replace the
   *      default one to do something with the access token. You will tipically
   *      use that function to set some info in session.
   *    - transform_token_response: a function which will replace
   *      the default one to obtain a hash containing the access_token from
   *      the OAuth2 server reply. This method should be provided if the
   *      OAuth2 server we are requesting does not return JSON encoded data.
   *
   */
  conf.default_redirection_url = conf.default_redirection_url || '/';
  CLIENT.config = conf;
  var cconf = CLIENT.config.client;
  options = options || {};
  [ 'valid_grant'
  , 'treat_access_token'
  , 'transform_token_response'
  ].forEach(function(fctName) {
    if(options[fctName]) CLIENT[fctName] = options[fctName];
  });

  var routes = {GET: {}};
  routes.GET[cconf.process_login_url] = CLIENT.auth_process_login;
  routes.GET[cconf.login_url] = login;
  routes.GET[cconf.logout_url] = logout;
  return tools.get_connector_from_str_routes(routes);
};

