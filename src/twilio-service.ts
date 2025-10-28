import Twilio from 'twilio';

const accountSid = process.env.TWILIO_ACCOUNT_SID;
const authToken = process.env.TWILIO_AUTH_TOKEN;

if (!accountSid || !authToken) {
  console.warn('Twilio credentials not configured - phone number management will be limited');
}

const client = accountSid && authToken ? Twilio(accountSid, authToken) : null;

export interface TwilioPhoneNumber {
  phoneNumber: string;
  friendlyName: string;
  voiceUrl?: string;
  statusCallback?: string;
  capabilities?: {
    voice: boolean;
    sms: boolean;
    mms: boolean;
  };
  sid?: string;
  addressRequirements?: string;
  beta?: boolean;
  capabilities_voice?: boolean;
  capabilities_sms?: boolean;
  capabilities_mms?: boolean;
  locality?: string;
  region?: string;
  isoCountry?: string;
}

export interface AvailableNumber {
  phoneNumber: string;
  friendlyName: string;
  locality?: string;
  region?: string;
  isoCountry?: string;
  capabilities?: {
    voice: boolean;
    sms: boolean;
    mms: boolean;
  };
}

export async function checkExistingNumber(phoneNumber: string): Promise<TwilioPhoneNumber | null> {
  if (!client) {
    throw new Error('Twilio client not configured');
  }

  try {
    // Ensure phone number is in E.164 format
    const formattedNumber = phoneNumber.startsWith('+') ? phoneNumber : `+${phoneNumber}`;
    
    // Get all incoming phone numbers and find the matching one
    const numbers = await client.incomingPhoneNumbers.list();
    const matchingNumber = numbers.find((n: any) => n.phoneNumber === formattedNumber);

    if (!matchingNumber) {
      return null;
    }

    return {
      phoneNumber: matchingNumber.phoneNumber,
      friendlyName: matchingNumber.friendlyName,
      voiceUrl: matchingNumber.voiceUrl || undefined,
      statusCallback: matchingNumber.statusCallback || undefined,
      capabilities: {
        voice: matchingNumber.capabilities?.voice || false,
        sms: matchingNumber.capabilities?.sms || false,
        mms: matchingNumber.capabilities?.mms || false,
      },
      sid: matchingNumber.sid,
    };
  } catch (error) {
    console.error('Error checking existing Twilio number:', error);
    throw error;
  }
}

export interface SearchNumbersOptions {
  country?: string;
  areaCode?: string;
  contains?: string;
  limit?: number;
  numberType?: 'local' | 'tollFree' | 'mobile';
}

export async function searchAvailableNumbers(options: SearchNumbersOptions): Promise<AvailableNumber[]> {
  if (!client) {
    throw new Error('Twilio client not configured');
  }

  const {
    country = 'US',
    areaCode,
    contains,
    limit = 20,
    numberType = 'local'
  } = options;

  try {
    let searchQuery: any = {
      limit,
      capabilities: {
        voice: true,
      },
    };

    // Add optional search parameters
    if (areaCode) {
      searchQuery.areaCode = areaCode;
    }
    if (contains) {
      searchQuery.contains = contains;
    }

    // Search based on number type
    const availablePhoneNumbers = client.availablePhoneNumbers(country);
    let availableNumbers;
    
    switch (numberType) {
      case 'tollFree':
        availableNumbers = await availablePhoneNumbers.tollFree.list(searchQuery);
        break;
      case 'mobile':
        availableNumbers = await availablePhoneNumbers.mobile.list(searchQuery);
        break;
      case 'local':
      default:
        availableNumbers = await availablePhoneNumbers.local.list(searchQuery);
        break;
    }

    return availableNumbers.map((num: any) => ({
      phoneNumber: num.phoneNumber,
      friendlyName: num.friendlyName,
      locality: num.locality,
      region: num.region,
      isoCountry: num.isoCountry,
      capabilities: {
        voice: num.capabilities?.voice || false,
        sms: num.capabilities?.sms || false,
        mms: num.capabilities?.mms || false,
      },
    }));
  } catch (error) {
    console.error('Error searching available Twilio numbers:', error);
    throw error;
  }
}

export async function purchasePhoneNumber(phoneNumber: string, voiceUrl?: string, addressSid?: string): Promise<TwilioPhoneNumber> {
  if (!client) {
    throw new Error('Twilio client not configured');
  }

  try {
    const purchaseParams: any = {
      phoneNumber: phoneNumber,
      voiceUrl: voiceUrl,
      voiceMethod: 'POST',
    };
    
    // Add addressSid if provided (required for certain phone numbers)
    if (addressSid) {
      purchaseParams.addressSid = addressSid;
    }
    
    const purchased = await client.incomingPhoneNumbers.create(purchaseParams);

    return {
      phoneNumber: purchased.phoneNumber,
      friendlyName: purchased.friendlyName,
      voiceUrl: purchased.voiceUrl || undefined,
      statusCallback: purchased.statusCallback || undefined,
      capabilities: {
        voice: purchased.capabilities?.voice || false,
        sms: purchased.capabilities?.sms || false,
        mms: purchased.capabilities?.mms || false,
      },
      sid: purchased.sid,
    };
  } catch (error) {
    console.error('Error purchasing Twilio number:', error);
    throw error;
  }
}

export async function releasePhoneNumber(twilioSid: string): Promise<boolean> {
  if (!client) {
    throw new Error('Twilio client not configured');
  }

  try {
    await client.incomingPhoneNumbers(twilioSid).remove();
    return true;
  } catch (error) {
    console.error('Error releasing Twilio number:', error);
    throw error;
  }
}

export async function updatePhoneNumberWebhooks(twilioSid: string, voiceUrl?: string, statusCallback?: string): Promise<boolean> {
  if (!client) {
    throw new Error('Twilio client not configured');
  }

  try {
    await client.incomingPhoneNumbers(twilioSid).update({
      voiceUrl: voiceUrl,
      voiceMethod: 'POST',
      statusCallback: statusCallback,
      statusCallbackMethod: 'POST',
    });
    return true;
  } catch (error) {
    console.error('Error updating Twilio number webhooks:', error);
    throw error;
  }
}

export async function getPhoneNumberDetails(twilioSid: string): Promise<TwilioPhoneNumber | null> {
  if (!client) {
    throw new Error('Twilio client not configured');
  }

  try {
    const number = await client.incomingPhoneNumbers(twilioSid).fetch();

    return {
      phoneNumber: number.phoneNumber,
      friendlyName: number.friendlyName,
      voiceUrl: number.voiceUrl || undefined,
      statusCallback: number.statusCallback || undefined,
      capabilities: {
        voice: number.capabilities?.voice || false,
        sms: number.capabilities?.sms || false,
        mms: number.capabilities?.mms || false,
      },
      sid: number.sid,
      locality: number.locality || undefined,
      region: number.region || undefined,
      isoCountry: number.isoCountry || undefined,
    };
  } catch (error) {
    console.error('Error fetching Twilio number details:', error);
    throw error;
  }
}