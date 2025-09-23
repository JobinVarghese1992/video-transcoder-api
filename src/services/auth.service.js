// src/services/auth.service.js
import 'dotenv/config';
import crypto from 'crypto';
import {
  CognitoIdentityProviderClient,
  SignUpCommand,
  ConfirmSignUpCommand,
  AdminAddUserToGroupCommand,
  InitiateAuthCommand,
  RespondToAuthChallengeCommand,
  AuthFlowType,
} from '@aws-sdk/client-cognito-identity-provider';

const params = await getParams(["USERPOOL_ID", "CLIENT_ID", "CLIENT_SECRET", "DEFAULT_USER_GROUP"]);

const region = process.env.AWS_REGION || 'ap-southeast-2';
const userPoolId = params.USERPOOL_ID;
const clientId = params.CLIENT_ID;
const clientSecret = params.CLIENT_SECRET;
const defaultUserGroup = params.DEFAULT_USER_GROUP || 'customers';

const cognito = new CognitoIdentityProviderClient({ region });

function secretHash(clientId, clientSecret, username) {
  const hasher = crypto.createHmac('sha256', clientSecret);
  hasher.update(`${username}${clientId}`);
  return hasher.digest('base64');
}

function mapGroupsToRole(groups = []) {
  return groups.includes('admin') ? 'admin' : 'user';
}

export async function signup(username, password, email) {
  try {
    const res = await cognito.send(new SignUpCommand({
      ClientId: clientId,
      SecretHash: secretHash(clientId, clientSecret, username),
      Username: username,
      Password: password,
      UserAttributes: [{ Name: 'email', Value: email }],
    }));

    try {
      await cognito.send(new AdminAddUserToGroupCommand({
        UserPoolId: userPoolId,
        Username: username,
        GroupName: defaultUserGroup,
      }));
    } catch (e) {
      console.warn('AdminAddUserToGroup failed (non-fatal):', e?.name || e?.message || e);
    }

    return {
      success: true,
      message: 'Signup successful. Please confirm your email with the verification code.',
      data: { userConfirmed: res.UserConfirmed, codeDelivery: res.CodeDeliveryDetails },
    };
  } catch (err) {
    let message = 'Signup failed.';
    if (err.name === 'UsernameExistsException') message = 'This username already exists.';
    else if (err.name === 'InvalidPasswordException') message = 'Password does not meet security requirements.';
    else if (err.message) message = err.message;

    return { success: false, message, error: { name: err.name, status: err.$metadata?.httpStatusCode } };
  }
}

export async function confirmSignup(username, confirmationCode) {
  try {
    await cognito.send(new ConfirmSignUpCommand({
      ClientId: clientId,
      SecretHash: secretHash(clientId, clientSecret, username),
      Username: username,
      ConfirmationCode: confirmationCode,
    }));

    return { success: true, message: 'User confirmed successfully.' };
  } catch (err) {
    let message = 'Confirmation failed.';
    if (err.name === 'CodeMismatchException') message = 'Invalid confirmation code.';
    else if (err.name === 'ExpiredCodeException') message = 'Confirmation code has expired.';
    else if (err.message) message = err.message;

    return { success: false, message, error: { name: err.name, status: err.$metadata?.httpStatusCode } };
  }
}

export async function login(username, password) {
  try {
    const res = await cognito.send(new InitiateAuthCommand({
      AuthFlow: AuthFlowType.USER_PASSWORD_AUTH,
      ClientId: clientId,
      AuthParameters: {
        USERNAME: username,
        PASSWORD: password,
        SECRET_HASH: secretHash(clientId, clientSecret, username),
      },
    }));


    if (res.ChallengeName) {
      return {
        success: true,
        challenge: res.ChallengeName,
        session: res.Session,
        parameters: res.ChallengeParameters,
        message: `Challenge required: ${res.ChallengeName}`,
      };
    }

    const { IdToken, AccessToken, RefreshToken, ExpiresIn, TokenType } = res.AuthenticationResult || {};
    return {
      success: true,
      message: 'Signin successful.',
      data: {
        idToken: IdToken,
        accessToken: AccessToken,
        refreshToken: RefreshToken,
        tokenType: TokenType,
        expiresIn: ExpiresIn,
      },
    };
  } catch (err) {
    let message = 'Signin failed.';
    if (err.name === 'UserNotConfirmedException') message = 'User not confirmed. Please confirm signup.';
    else if (err.name === 'NotAuthorizedException') message = 'Incorrect username or password.';
    else if (err.message) message = err.message;

    return { success: false, message, error: { name: err.name, status: err.$metadata?.httpStatusCode } };
  }
}

export async function confirmSignin(username, confirmationCode, session) {
  try {
    const response = await cognito.send(new RespondToAuthChallengeCommand({
      ClientId: clientId,
      ChallengeName: 'EMAIL_OTP',
      Session: session,
      ChallengeResponses: {
        USERNAME: username,
        SECRET_HASH: secretHash(clientId, clientSecret, username),
        EMAIL_OTP_CODE: confirmationCode,
      },
    }));

    const { IdToken, AccessToken, RefreshToken, ExpiresIn, TokenType } = response.AuthenticationResult || {};

    return {
      success: true,
      message: 'Signin confirmed.',
      data: {
        idToken: IdToken,
        accessToken: AccessToken,
        refreshToken: RefreshToken,
        tokenType: TokenType,
        expiresIn: ExpiresIn,
      },
    };
  } catch (err) {
    let message = 'Signin confirmation failed.';
    if (err.name === 'CodeMismatchException') message = 'Invalid code.';
    else if (err.name === 'ExpiredCodeException') message = 'Code expired.';
    else if (err.message) message = err.message;

    return { success: false, message, error: { name: err.name, status: err.$metadata?.httpStatusCode } };
  }
}
