import { describe, expect, it } from 'vitest';
import {
  checkProperties,
  formType,
  messageClassProperties,
  messageClassUpdate,
  packageCreate,
  packageProperties,
  packageUpdate,
} from '../../src/capabilities/properties.js';
import type { PackageDefinition } from '../../src/capabilities/package.js';

const pkg: PackageDefinition = {
  name: 'ZADTPLUS_ORDERS',
  description: 'Orders',
  masterLanguage: 'EN',
  responsible: 'DEVELOPER',
  packageType: 'development',
  recordChanges: true,
  languageVersion: '5',
  superPackage: 'ZADTPLUS_TEST',
  applicationComponent: '',
  softwareComponent: 'HOME',
  transportLayer: 'ZDEV',
};

describe('form-based types', () => {
  it('are DEVC and MSAG, with or without the subtype', () => {
    expect(formType('DEVC/K')).toBe('DEVC');
    expect(formType('msag/n')).toBe('MSAG');
    expect(formType('MSAG')).toBe('MSAG');
    expect(formType('CLAS/OC')).toBeUndefined();
  });
});

describe('checkProperties', () => {
  it('takes a partial document: AFF\'s required fields are not required', () => {
    expect(checkProperties('MSAG/N', { messages: [{ number: '001', text: 'x' }] })).toEqual({ messages: [{ number: '001', text: 'x' }] });
    expect(checkProperties('DEVC/K', { header: { description: 'd' } })).toEqual({ header: { description: 'd' } });
  });

  it('refuses a key AFF does not know, naming it and the type\'s fields', () => {
    expect(() => checkProperties('MSAG/N', { messages: [{ number: '001', text: 'x', selfExplanatory: true }] })).toThrow(
      /messages\.0 has "selfExplanatory", which AFF doesn't know.*Its fields: header\.description, header\.originalLanguage, messages\[\]\.number, messages\[\]\.text/,
    );
    expect(() => checkProperties('DEVC/K', { generalInformation: { recordChanges: true } })).toThrow(/"recordChanges", which AFF doesn't know/);
  });

  it('refuses values AFF\'s schema refuses', () => {
    expect(() => checkProperties('MSAG/N', { messages: [{ number: '0001', text: 'x' }] })).toThrow(/messages\.0\.number/);
    expect(() => checkProperties('DEVC/K', { generalInformation: { defaultAbapLanguageVersion: 'cloud' } })).toThrow(/defaultAbapLanguageVersion/);
  });

  it('refuses properties on a source-based type', () => {
    expect(() => checkProperties('CLAS/OC', {})).toThrow(/takes "source", not "properties"/);
  });
});

describe('message classes', () => {
  it('read as msag-v1, messages by number, without the self-explanatory flag', () => {
    const mc = {
      description: 'Demo',
      masterLanguage: 'EN',
      messages: [
        { number: '002', text: 'b', selfExplanatory: true },
        { number: '001', text: 'a', selfExplanatory: false },
      ],
    };
    expect(messageClassProperties(mc)).toEqual({
      formatVersion: '1',
      header: { description: 'Demo', originalLanguage: 'en' },
      messages: [
        { number: '001', text: 'a' },
        { number: '002', text: 'b' },
      ],
    });
  });

  it('update with the messages given and the description, nothing else', () => {
    expect(messageClassUpdate({ messages: [{ number: '001', text: 'x' }] })).toEqual({ messages: [{ number: '001', text: 'x' }] });
    expect(messageClassUpdate({ header: { description: 'D' } })).toEqual({ description: 'D' });
    expect(() => messageClassUpdate({ header: { originalLanguage: 'de' } })).toThrow(/header\.originalLanguage/);
    expect(() => messageClassUpdate({ formatVersion: '1', messages: [{ number: '001', text: 'x' }] })).toThrow(/formatVersion/);
    expect(() => messageClassUpdate({ messages: [{ number: '001' }] })).toThrow(/message 001 has no "text"; leaving a message out keeps it/);
    expect(() => messageClassUpdate({})).toThrow(/needs "messages" and\/or "header.description"/);
  });
});

describe('packages', () => {
  it('read as devc-v1, empty optional fields left out', () => {
    expect(packageProperties(pkg)).toEqual({
      formatVersion: '1',
      header: { description: 'Orders', originalLanguage: 'en' },
      generalInformation: {
        type: 'development',
        superPackage: 'ZADTPLUS_TEST',
        softwareComponent: 'HOME',
        transportLayer: 'ZDEV',
        supportsRecordChanges: true,
        defaultAbapLanguageVersion: 'cloudDevelopment',
      },
    });
    expect(packageProperties({ ...pkg, addingObjectsNotPossible: true }).generalInformation).toMatchObject({ isAddingObjectsNotAllowed: true });
  });

  it('read back what checkProperties accepts', () => {
    expect(() => checkProperties('DEVC/K', packageProperties(pkg))).not.toThrow();
  });

  it('update the description and the application component only', () => {
    expect(packageUpdate({ header: { description: 'New' }, generalInformation: { applicationComponent: 'SD' } })).toEqual({
      description: 'New',
      applicationComponent: 'SD',
    });
    expect(() => packageUpdate({ generalInformation: { superPackage: 'ZOTHER' } })).toThrow(/generalInformation\.superPackage: adt\+ changes a package's header\.description and generalInformation\.applicationComponent only/);
    expect(() => packageUpdate({ generalInformation: { defaultAbapLanguageVersion: 'standard' } })).toThrow(/defaultAbapLanguageVersion/);
    expect(() => packageUpdate({ header: { originalLanguage: 'de' } })).toThrow(/header\.originalLanguage/);
    expect(() => packageUpdate({})).toThrow(/needs "header.description" and\/or/);
  });

  it('create from generalInformation; name, superpackage and description come as the create\'s own parameters', () => {
    expect(packageCreate(undefined)).toEqual({});
    expect(
      packageCreate({
        generalInformation: { softwareComponent: 'HOME', transportLayer: 'ZDEV', supportsRecordChanges: false, defaultAbapLanguageVersion: 'standard' },
      }),
    ).toEqual({ softwareComponent: 'HOME', transportLayer: 'ZDEV', recordChanges: false, languageVersion: 'standard' });
    expect(() => packageCreate({ generalInformation: { superPackage: 'ZX' } })).toThrow(/the superpackage is the create's "package"/);
    expect(() => packageCreate({ header: { description: 'x' } })).toThrow(/header/);
    expect(() => packageCreate({ generalInformation: { type: 'main' } })).toThrow(/development packages only/);
  });
});
