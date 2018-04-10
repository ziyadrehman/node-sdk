/**
 * Copyright 2014 IBM Corp. All Rights Reserved.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

// new Buffer() is deprecated, replaced with Buffer.from() in node v4.5.0+ -
// `buffer-from` uses the new api when possible but falls back to the old one otherwise
import bufferFrom = require('buffer-from');
import extend = require('extend');
import request = require('request');
import vcapServices = require('vcap_services');
import { stripTrailingSlash } from './helper';
import { refreshToken, requestToken } from './iamTokenManager';
import { sendRequest } from './requestwrapper';

// custom interfaces
export interface HeaderOptions {
  'X-Watson-Learning-Opt-Out'?: boolean;
  [key: string]: any;
}

export interface UserOptions {
  url?: string;
  version?: string;
  username?: string;
  password?: string;
  api_key?: string;
  apikey?: string;
  use_unauthenticated?: boolean;
  headers?: HeaderOptions;
  token?: string;
  access_token?: string;
  iam_apikey?: string;
  iam_url?: string;
}

export interface BaseServiceOptions extends UserOptions {
  headers: HeaderOptions;
  url: string;
  jar?: request.CookieJar;
  qs: any;
}

export interface Credentials {
  username?: string;
  password?: string;
  api_key?: string;
  url?: string;
  access_token?: string;
  iam_apikey?: string;
  iam_url?: string;
}

export interface IamTokenData {
  access_token: string;
  refresh_token: string;
  token_type: string;
  expires_in: number;
  expiration: number;
}

function hasCredentials(obj: any): boolean {
  return (
    obj &&
    ((obj.username && obj.password) ||
      obj.api_key ||
      obj.access_token ||
      obj.refresh_token ||
      obj.iam_apikey)
  );
}

function hasBasicCredentials(obj: any): boolean {
  return obj && obj.username && obj.password;
}

function hasAccessToken(obj: any): boolean {
  return obj && obj.access_token;
}

export class BaseService {
  static URL: string;
  name: string;
  serviceVersion: string;
  protected _options: BaseServiceOptions;
  protected serviceDefaults: object;
  protected tokenInfo: IamTokenData;

  /**
   * Internal base class that other services inherit from
   * @param {UserOptions} options
   * @param {string} [options.username] - required unless use_unauthenticated is set
   * @param {string} [options.password] - required unless use_unauthenticated is set
   * @param {boolean} [options.use_unauthenticated] - skip credential requirement
   * @param {HeaderOptions} [options.headers]
   * @param {boolean} [options.headers.X-Watson-Learning-Opt-Out=false] - opt-out of data collection
   * @param {string} [options.url] - override default service base url
   * @private
   * @abstract
   * @constructor
   * @throws {Error}
   * @returns {BaseService}
   */
  constructor(userOptions: UserOptions) {
    if (!(this instanceof BaseService)) {
      // it might be better to just create a new instance and return that..
      // but that can't be done here, it has to be done in each individual service.
      // So this is still a good failsafe even in that case.
      throw new Error(
        'the "new" keyword is required to create Watson service instances'
      );
    }
    const options = extend({}, userOptions);
    const _options = this.initCredentials(options);
    if (options.url) {
      _options.url = stripTrailingSlash(options.url);
    }
    const serviceClass = this.constructor as typeof BaseService;
    this._options = extend(
      { qs: {}, url: serviceClass.URL },
      this.serviceDefaults,
      options,
      _options
    );
    this.tokenInfo = {} as IamTokenData;
  }

  /**
   * Retrieve this service's credentials - useful for passing to the authorization service
   *
   * Only returns a URL when token auth is used.
   *
   * @returns {Credentials}
   */
  public getCredentials(): Credentials {
    const _credentials = {} as Credentials;
    if (this._options.username) {
      _credentials.username = this._options.username;
    }
    if (this._options.password) {
      _credentials.password = this._options.password;
    }
    if (this._options.api_key) {
      _credentials.api_key = this._options.api_key;
    }
    if (this._options.url) {
      _credentials.url = this._options.url;
    }
    if (this._options.access_token) {
      _credentials.access_token = this._options.access_token;
    }
    if (this._options.iam_apikey) {
      _credentials.iam_apikey = this._options.iam_apikey;
    }
    if (this._options.iam_url) {
      _credentials.iam_url = this._options.iam_url;
    }
    return _credentials;
  }

  /**
   * Set an IAM access token to use when authenticating with the service.
   * The access token should be valid and not yet expired.
   *
   * By using this method, you accept responsibility for managing the
   * access token yourself. You must set a new access token before this
   * one expires. Failing to do so will result in authentication errors
   * after this token expires.
   *
   * @param {string} access_token - A valid, non-expired IAM access token
   * @returns {void}
   */
  public setAccessToken(access_token: string) { // tslint:disable-line variable-name
    this._options.access_token = access_token;
    this._options.headers = this._options.headers || {};
    this._options.headers.Authorization = `Bearer ${access_token}`;
  }

/**
 * Wrapper around `sendRequest` that manages access tokens if applicable
 * 1. If user gives an iam_apikey, start managing tokens
 *   a. If user gives an iam_apikey and no token is saved, request an access token
 *   b. If a token is saved but is expired, refresh the token
 *   c. If token is saved and valid, use it to authenticate the service request
 * 2. If the user gives the access token, basic auth credentials, or an api key:
 *    don't manage tokens and call sendRequest
 *
 * @param {Object} parameters - service request options passed in by user
 * @param {Function} _callback - callback function to pass the reponse back to
 * @returns {ReadableStream|undefined}
 */
  protected createRequest(parameters, _callback) {
    const URL = this._options.iam_url || 'https://iam.ng.bluemix.net/identity/token';
    if (this.managingTokens()) {
      if (this.needToRequestToken()) {
        requestToken(this._options.iam_apikey, URL, (tokenResponse) => {
          this.saveTokenInfo(tokenResponse);
          parameters.defaultOptions.headers.Authorization =
            `Bearer ${this.tokenInfo.access_token}`;
          return sendRequest(parameters, _callback);
        });
      } else if (this.tokenIsExpired()) {
        refreshToken(this.tokenInfo.refresh_token, URL, (tokenResponse) => {
          this.saveTokenInfo(tokenResponse);
          parameters.defaultOptions.headers.Authorization =
            `Bearer ${this.tokenInfo.access_token}`;
          return sendRequest(parameters, _callback);
        });
      } else {
        parameters.defaultOptions.headers.Authorization =
          `Bearer ${this.tokenInfo.access_token}`;
        return sendRequest(parameters, _callback);
      }
    } else {
      return sendRequest(parameters, _callback);
    }
  }
  /**
   * @private
   * @param {UserOptions} options
   * @returns {BaseServiceOptions}
   */
  private initCredentials(options: UserOptions): BaseServiceOptions {
    let _options: BaseServiceOptions = {} as BaseServiceOptions;
    if (options.token) {
      options.headers = options.headers || {};
      options.headers['X-Watson-Authorization-Token'] = options.token;
      _options = extend(_options, options);
      return _options;
    }
    if (options.api_key || options.apikey) {
      _options.api_key = options.api_key || options.apikey;
    }
    _options.jar = request.jar();
    // Get credentials from environment properties or Bluemix,
    // but prefer credentials provided programatically
    _options = extend(
      {},
      this.getCredentialsFromBluemix(this.name),
      this.getCredentialsFromEnvironment(this.name),
      options,
      _options
    );
    if (!_options.use_unauthenticated) {
      if (!hasCredentials(_options)) {
        const errorMessage = 'Insufficient credentials provided in ' +
          'constructor argument. Refer to the documentation for the ' +
          'required parameters. Common examples are username/password, ' +
          'api_key, and access_token.';
        throw new Error(errorMessage);
      }
      if (hasBasicCredentials(_options)) {
        // Calculate and add Authorization header to base options
        const encodedCredentials = bufferFrom(
          `${_options.username}:${_options.password}`
        ).toString('base64');
        const authHeader = { Authorization: `Basic ${encodedCredentials}` };
        _options.headers = extend(authHeader, _options.headers);
      } else if (hasAccessToken(_options)) {
        const authHeader = { Authorization: `Bearer ${_options.access_token}` };
        _options.headers = extend(authHeader, _options.headers);
      } else {
        _options.qs = extend({ api_key: _options.api_key }, _options.qs);
      }
    }
    return _options;
  }
  /**
   * Pulls credentials from env properties
   *
   * Property checked is uppercase service.name suffixed by _USERNAME and _PASSWORD
   *
   * For example, if service.name is speech_to_text,
   * env properties are SPEECH_TO_TEXT_USERNAME and SPEECH_TO_TEXT_PASSWORD
   *
   * @private
   * @param {string} name - the service snake case name
   * @returns {Credentials}
   */
  private getCredentialsFromEnvironment(name: string): Credentials {
    if (name === 'watson_vision_combined') {
      return this.getCredentialsFromEnvironment('visual_recognition');
    }
    // Case handling for assistant - should look for assistant env variables before conversation
    if (name === 'conversation' && process.env[`ASSISTANT_USERNAME`]) {
       return this.getCredentialsFromEnvironment('assistant');
    }
    const _name: string = name.toUpperCase();
    // https://github.com/watson-developer-cloud/node-sdk/issues/605
    const _nameWithUnderscore: string = _name.replace(/-/g, '_');
    const _username: string = process.env[`${_name}_USERNAME`] || process.env[`${_nameWithUnderscore}_USERNAME`];
    const _password: string = process.env[`${_name}_PASSWORD`] || process.env[`${_nameWithUnderscore}_PASSWORD`];
    const _apiKey: string = process.env[`${_name}_API_KEY`] || process.env[`${_nameWithUnderscore}_API_KEY`];
    const _url: string = process.env[`${_name}_URL`] || process.env[`${_nameWithUnderscore}_URL`];
    const _accessToken: string = process.env[`${_name}_ACCESS_TOKEN`] || process.env[`${_nameWithUnderscore}_ACCESS_TOKEN`];
    const _iamApiKey: string = process.env[`${_name}_PLATFORM_API_KEY`] || process.env[`${_nameWithUnderscore}_PLATFORM_API_KEY`];

    return {
      username: _username,
      password: _password,
      api_key: _apiKey,
      url: _url,
      access_token: _accessToken,
      iam_apikey: _iamApiKey
    };
  }
  /**
   * Pulls credentials from VCAP_SERVICES env property that bluemix sets
   * @param {string} vcap_services_name
   * @private
   * @returns {Credentials}
   */
  private getCredentialsFromBluemix(vcapServicesName: string): Credentials {
    let _credentials: Credentials;
    let temp: any;
    if (this.name === 'visual_recognition') {
      temp = vcapServices.getCredentials('watson_vision_combined');
    } else {
      temp = vcapServices.getCredentials(vcapServicesName);
    }
    // convert an iam apikey to use the identifier iam_apikey
    if (temp.apikey && temp.iam_apikey_name) {
      temp.iam_apikey = temp.apikey;
    }
    _credentials = temp;
    return _credentials;
  }
  /**
   * Determines if access tokens need to be internally managed based on
   * user provided input.
   * @private
   * @returns {boolean}
   */
  private managingTokens(): boolean {
    return !!this._options.iam_apikey;
  }
  /**
   * Determines if a token needs to be requested based on the presence
   * of an access_token
   * @private
   * @returns {boolean}
   */
  private needToRequestToken(): boolean {
    return !this.tokenInfo.access_token;
  }
  /**
   * Saves the token response data to the object state
   * @private
   * @param {IamTokenData} tokenResponse
   * @returns {void}
   */
  private saveTokenInfo(tokenResponse: IamTokenData): void {
    this.tokenInfo = extend({}, tokenResponse);
  }
  /**
   * Checks if token is nearing its expiration time
   * The token should be refreshed if past a certain percentage of its time to live
   * @private
   * @returns {boolean}
   */
  private tokenIsExpired(): boolean {
    // use a buffer to prevent the edge case of the token
    // expiring before the request could be made
    // the buffer will be a fraction of the total TTL
    const fractionOfTtl = 0.8;
    const timeToLive = this.tokenInfo.expires_in;
    const expireTime = this.tokenInfo.expiration;
    return expireTime - (timeToLive * (1.0 - fractionOfTtl))
      < Math.floor(Date.now() / 1000);
  }
}
