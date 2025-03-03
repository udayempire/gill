import {
  Address,
  address,
  createSolanaClient,
  getAddressEncoder,
  getProgramDerivedAddress,
} from "gill";

export async function generateSHA256Hash(message: string): Promise<Buffer> {
  const hashBuffer = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(message),
  );
  return Buffer.from(hashBuffer);
  // return Array.from(new Uint8Array(hashBuffer))
  //   .map((byte) => byte.toString(16).padStart(2, "0"))
  //   .join("");
}

/**
 * The `.sol` TLD
 */
export const ROOT_DOMAIN_ACCOUNT = address(
  "58PwtjSDuFHuUkYjH9BYnnQKHfwo9reZhC2zMJv9JPkx",
);

/**
 * The Solana Name Service program ID
 */
export const NAME_PROGRAM_ID = address(
  "namesLPneVptA9Z5rqUDD9tMTWEJwofgaYwp8cawRkX",
);

/**
 * Hash prefix used to derive domain name addresses
 */
export const HASH_PREFIX = "SPL Name Service";

// export const getHashedNameSync = (name: string): Buffer => {
//   const input = HASH_PREFIX + name;
//   // return await generateSHA256Hash(input)
//   const hashed = sha256(Buffer.from(input, "utf8"));
//   return Buffer.from(hashed);
// };
export const getHashedName = async (name: string): Promise<Buffer> => {
  const input = HASH_PREFIX + name;
  return await generateSHA256Hash(input);
};

export async function getSnsNameAccount(
  hashed_name: Buffer,
  nameClass?: Address,
  nameParent?: Address,
): Promise<Address> {
  return (
    await getProgramDerivedAddress({
      programAddress: NAME_PROGRAM_ID,
      seeds: [
        hashed_name,
        nameClass ? getAddressEncoder().encode(nameClass) : Buffer.alloc(32),
        nameParent ? getAddressEncoder().encode(nameParent) : Buffer.alloc(32),
      ],
    })
  )[0];
}

// export const getNameAccountKeySync = (
//   hashed_name: Buffer,
//   nameClass?: Address,
//   nameParent?: Address,
// ): Address => {
//   const seeds = [hashed_name];
//   if (nameClass) {
//     seeds.push(nameClass.toBuffer());
//   } else {
//     seeds.push(Buffer.alloc(32));
//   }
//   if (nameParent) {
//     seeds.push(nameParent.toBuffer());
//   } else {
//     seeds.push(Buffer.alloc(32));
//   }
//   const [nameAccountKey] = PublicKey.findProgramAddressSync(
//     seeds,
//     NAME_PROGRAM_ID,
//   );
//   return nameAccountKey;
// };

// const _deriveSync = (
//   name: string,
//   parent: Address = ROOT_DOMAIN_ACCOUNT,
//   classKey?: Address,
// ) => {
//   let hashed = getHashedNameSync(name);
//   // let pubkey = getNameAccountKeySync(hashed, classKey, parent);
//   let pubkey = getSnsNameAccount(hashed, classKey, parent);
//   return { pubkey, hashed };
// };

async function deriveSync(
  name: string,
  parent: Address = ROOT_DOMAIN_ACCOUNT,
  classKey?: Address,
) {
  let hashed = await getHashedName(name);
  let pubkey = await getSnsNameAccount(hashed, classKey, parent);
  return { pubkey, hashed };
}

export const getDomainKeySync = async (
  domain: string,
  record?: any /* RecordVersion*/,
) => {
  if (domain.endsWith(".sol")) {
    domain = domain.slice(0, -4);
  }

  const recordClass = undefined;

  // const recordClass =
  //   record === RecordVersion.V2 ? CENTRAL_STATE_SNS_RECORDS : undefined;
  const splitted = domain.split(".");
  if (splitted.length === 2) {
    const prefix = Buffer.from([record ? record : 0]).toString();
    const sub = prefix.concat(splitted[0]);
    const { pubkey: parentKey } = await deriveSync(splitted[1]);
    const result = await deriveSync(sub, parentKey, recordClass);
    return { ...result, isSub: true, parent: parentKey };
  } else if (splitted.length === 3 && !!record) {
    // Parent key
    const { pubkey: parentKey } = await deriveSync(splitted[2]);
    // Sub domain
    const { pubkey: subKey } = await deriveSync(
      "\0".concat(splitted[1]),
      parentKey,
    );
    // Sub record
    const recordPrefix = `\x01`;
    // const recordPrefix = record === RecordVersion.V2 ? `\x02` : `\x01`;
    const result = await deriveSync(
      recordPrefix.concat(splitted[0]),
      subKey,
      recordClass,
    );
    return { ...result, isSub: true, parent: parentKey, isSubRecord: true };
  } else if (splitted.length >= 3) {
    // throw new SNSError(ErrorType.InvalidInput);
  }
  const result = await deriveSync(domain, ROOT_DOMAIN_ACCOUNT);
  return { ...result, isSub: false, parent: undefined };
};

export const resolve = async (
  connection: Connection,
  domain: string,
  config: ResolveConfig = { allowPda: false },
): Promise<PublicKey> => {
  const { pubkey } = getDomainKeySync(domain);
  const [nftRecordKey] = NftRecord.findKeySync(pubkey, NAME_TOKENIZER_ID);
  const solRecordV1Key = getRecordKeySync(domain, Record.SOL);
  const solRecordV2Key = getRecordV2Key(domain, Record.SOL);
  const [nftRecordInfo, solRecordV1Info, solRecordV2Info, registryInfo] =
    await connection.getMultipleAccountsInfo([
      nftRecordKey,
      solRecordV1Key,
      solRecordV2Key,
      pubkey,
    ]);

  if (!registryInfo?.data) {
    throw new DomainDoesNotExist(`Domain ${domain} does not exist`);
  }

  const registry = NameRegistryState.deserialize(registryInfo.data);

  // If NFT record active -> NFT owner is the owner
  if (nftRecordInfo?.data) {
    const nftRecord = NftRecord.deserialize(nftRecordInfo.data);
    if (nftRecord.tag === Tag.ActiveRecord) {
      const nftOwner = await retrieveNftOwnerV2(connection, pubkey);
      if (!nftOwner) {
        throw new CouldNotFindNftOwner();
      }
      return nftOwner;
    }
  }

  // Check SOL record V2
  recordV2: if (solRecordV2Info?.data) {
    const recordV2 = RecordV2.deserialize(solRecordV2Info.data);
    const stalenessId = recordV2.getStalenessId();
    const roaId = recordV2.getRoAId();
    const content = recordV2.getContent();

    if (content.length !== 32) {
      throw new RecordMalformed(`Record is malformed`);
    }

    if (
      recordV2.header.rightOfAssociationValidation !== Validation.Solana ||
      recordV2.header.stalenessValidation !== Validation.Solana
    ) {
      throw new WrongValidation();
    }

    if (!stalenessId.equals(registry.owner.toBuffer())) {
      break recordV2;
    }

    if (roaId.equals(content)) {
      return new PublicKey(content);
    }

    throw new InvalidRoAError(
      `The RoA ID shoudl be ${new PublicKey(
        content,
      ).toBase58()} but is ${new PublicKey(roaId).toBase58()} `,
    );
  }

  // Check SOL record V1
  if (solRecordV1Info?.data) {
    const encoder = new TextEncoder();
    const expectedBuffer = Buffer.concat([
      solRecordV1Info.data.slice(
        NameRegistryState.HEADER_LEN,
        NameRegistryState.HEADER_LEN + 32,
      ),
      solRecordV1Key.toBuffer(),
    ]);

    const expected = encoder.encode(expectedBuffer.toString("hex"));
    const valid = checkSolRecord(
      expected,
      solRecordV1Info.data.slice(
        NameRegistryState.HEADER_LEN + 32,
        NameRegistryState.HEADER_LEN + 32 + SIGNATURE_LENGTH_IN_BYTES,
      ),
      registry.owner,
    );

    if (valid) {
      return new PublicKey(
        solRecordV1Info.data.slice(
          NameRegistryState.HEADER_LEN,
          NameRegistryState.HEADER_LEN + 32,
        ),
      );
    }
  }

  // Check if the registry owner is a PDA
  const isOnCurve = PublicKey.isOnCurve(registry.owner);
  if (!isOnCurve) {
    if (config.allowPda === "any") {
      return registry.owner;
    } else if (config.allowPda) {
      const ownerInfo = await connection.getAccountInfo(registry.owner);
      const isAllowed = config.programIds?.some((e) =>
        ownerInfo?.owner?.equals(e),
      );

      if (isAllowed) {
        return registry.owner;
      }

      throw new PdaOwnerNotAllowed(
        `The Program ${ownerInfo?.owner.toBase58()} is not allowed`,
      );
    } else {
      throw new PdaOwnerNotAllowed();
    }
  }

  return registry.owner;
};

const domainKey = await getDomainKeySync("nickfrosty.sol");
console.log(domainKey);

const { rpc } = createSolanaClient({ urlOrMoniker: "mainnet" });

const accountInfo = await rpc
  .getAccountInfo(domainKey.pubkey, {
    encoding: "base64",
  })
  .send();
console.log(accountInfo);
