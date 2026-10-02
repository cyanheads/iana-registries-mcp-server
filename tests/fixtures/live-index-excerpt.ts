/**
 * @fileoverview An excerpt of the live IANA protocol index
 * (`https://www.iana.org/protocols`, fetched 2026-10-01T22:51:56Z: 2,844 entry
 * rows, 2,840 registry/sub-registry pairs) for the registry search ranking
 * tests. It holds every row of every pair that one of {@link LIVE_INDEX_QUERIES}
 * matches with singular and plural folded, in index order under its category.
 * The ranking orders only the entries a query matches, so each of those
 * queries ranks this excerpt exactly as it ranks the full index. Titles and
 * categories are IANA's (CC0); defining documents and procedures are left out.
 * @module tests/fixtures/live-index-excerpt
 */

import { categoryRow, entryRow, indexPage } from './protocol-index.js';

/** The queries whose complete match sets the excerpt holds. */
export const LIVE_INDEX_QUERIES = [
  'ip protocol numbers',
  'protocol numbers',
  'tls extensions',
  'dhcpv6 options',
  'dhcp options',
  'ethertype',
  'media types',
  'interface types',
  'command codes',
  'tls cipher suites',
  'dns rr types',
  'cbor tags',
  'http methods',
] as const;

/** Category rows, each with its `[href, title]` entry rows, in index order. */
export const LIVE_INDEX_GROUPS: readonly (readonly [
  category: string,
  rows: readonly (readonly [href: string, title: string])[],
])[] = [
  [
    'Access Node Control Protocol (ANCP)',
    [['/assignments/ancp#command-codes', 'ANCP Command Codes']],
  ],
  [
    'Application Access Protocol (ACAP) Numbers',
    [
      ['/assignments/acap-registrations#acap-registrations-1', 'ACAP Capabilities'],
      ['/assignments/acap-registrations#acap-registrations-2', 'ACAP Response Codes'],
      ['/assignments/acap-registrations#acap-registrations-3', 'Dataset Classes'],
      ['/assignments/acap-registrations#acap-registrations-4', 'Vendor Subtrees'],
    ],
  ],
  [
    'Authentication, Authorization, and Accounting (AAA) Parameters',
    [['/assignments/aaa-parameters#aaa-parameters-47', 'Command Codes']],
  ],
  [
    'Border Gateway Protocol (BGP) Parameters',
    [
      [
        '/assignments/bgp-parameters#pmsi-tunnel-types',
        'P-Multicast Service Interface Tunnel (PMSI Tunnel) Tunnel Types',
      ],
    ],
  ],
  [
    'Bundle Protocol',
    [
      [
        '/assignments/bundle#tcpcl-version',
        'Bundle Protocol TCP Convergence-Layer Version Numbers',
      ],
      ['/assignments/bundle#cbhe-service-numbers', 'CBHE Service Numbers'],
      ['/assignments/bundle#ciphersuite-numbers', 'Ciphersuite Numbers'],
    ],
  ],
  [
    'Cisco Service Level Assurance Protocol',
    [
      [
        '/assignments/cisco-sla-protocol#version-numbers',
        'Cisco SLA Protocol Version Number Registry',
      ],
    ],
  ],
  [
    'Common Open Policy Service (COPS) Protocol',
    [
      [
        '/assignments/cops-parameters#cops-parameters-5',
        'R-Types, Reason-Codes, Report-Types, Decision Object Command-Codes/Flags, and Error-Codes',
      ],
    ],
  ],
  [
    'Concise Binary Object Representation (CBOR)',
    [
      ['/assignments/cbor-tags#tags', 'CBOR Tags'],
      ['/assignments/cbor-tags#time-tag-map-keys', 'Time Tag Map Keys'],
      ['/assignments/cbor-tags#timescales', 'Timescales'],
    ],
  ],
  [
    'Datagram Congestion Control Protocol (DCCP) Parameters',
    [
      [
        '/assignments/dccp-ccid2-parameters#dccp-ccid2-parameters-3',
        'CCID2-specific Feature Numbers (128-255)',
      ],
      [
        '/assignments/dccp-ccid3-parameters#dccp-ccid3-parameters-3',
        'CCID3-specific Feature Numbers (128-255)',
      ],
      [
        '/assignments/dccp-ccid4-parameters#dccp-ccid4-parameters-3',
        'CCID4-specific Feature Numbers (128-255)',
      ],
      ['/assignments/dccp-parameters#dccp-parameters-7', 'Feature Numbers'],
    ],
  ],
  [
    'Domain Name System (DNS) Parameters',
    [
      ['/assignments/dns-parameters#dhcid-rr-digest-type-codes', 'DHCID RR Digest Type Codes'],
      ['/assignments/dns-parameters#dns-parameters-9', 'DHCID RR Identifier Type Codes'],
      ['/assignments/dns-parameters#dns-parameters-4', 'Resource Record (RR) TYPEs'],
      [
        '/assignments/dns-sshfp-rr-parameters#dns-sshfp-rr-parameters-2',
        'SSHFP RR types for fingerprint types',
      ],
      [
        '/assignments/dns-sshfp-rr-parameters#dns-sshfp-rr-parameters-1',
        'SSHFP RR Types for public key algorithms',
      ],
    ],
  ],
  [
    'Dynamic Host Configuration Protocol (DHCP) and Bootstrap Protocol (BOOTP) Parameters',
    [
      ['/assignments/bootp-dhcp-parameters#options', 'BOOTP Vendor Extensions and DHCP Options'],
      [
        '/assignments/bootp-dhcp-parameters#control-mask-bit',
        'CableLabs Client Configuration Option Ticket Control Mask Bit Definitions',
      ],
      [
        '/assignments/bootp-dhcp-parameters#type-122-sub-options',
        'DHCP Cablelabs Client Configuration Option Type 122 Sub-Option Codes',
      ],
      [
        '/assignments/bootp-dhcp-parameters#dhcpv4-options-atrribute',
        'DHCP Options Permitted in the RADIUS DHCPv4-Options Attribute',
      ],
      [
        '/assignments/bootp-dhcp-parameters#relay-agent-sub-options',
        'DHCP Relay Agent Sub-Option Codes',
      ],
      [
        '/assignments/bootp-dhcp-parameters#geoloc-option-version',
        'GeoLoc Option Version Registry',
      ],
      [
        '/assignments/bootp-dhcp-parameters#ieee-80221-service-type',
        'IEEE 802.21 Service Type (MoS DHCPv4 Address and FQDN Sub-Options)',
      ],
      [
        '/assignments/bootp-dhcp-parameters#type-63-sub-options',
        'NetWare/IP Option Type 63 Sub-Option Codes',
      ],
      ['/assignments/bootp-dhcp-parameters#vss-type', 'VSS Type Options'],
    ],
  ],
  [
    'Dynamic Host Configuration Protocol for IPv6 (DHCPv6)',
    [
      [
        '/assignments/dhcpv6-parameters#dhcpv6-options-attribute',
        'DHCPv6 Options Permitted in the RADIUS DHCPv6-Options Attribute',
      ],
      [
        '/assignments/dhcpv6-parameters#ieee-80221-service-type',
        'IEEE 802.21 Service Type (MoS DHCPv6 Address and FQDN Sub-Options)',
      ],
      ['/assignments/dhcpv6-parameters#dhcpv6-parameters-2', 'Option Codes'],
      [
        '/assignments/dhcpv6-parameters#option-codes-s46-priority-option',
        'Option Codes Permitted in the S46 Priority Option',
      ],
      ['/assignments/dhcpv6-parameters#dhcpv6-parameters-7', 'OPTION_LQ_QUERY option'],
      [
        '/assignments/dhcpv6-parameters#options-relay-supplied',
        'Options Permitted in the Relay-Supplied Options Option',
      ],
      [
        '/assignments/dhcpv6-parameters#radius-option-attributes',
        'RADIUS Attributes Permitted in DHCPv6 RADIUS Option',
      ],
      ['/assignments/dhcpv6-parameters#vss-type', 'VSS Type Options'],
    ],
  ],
  [
    'Extensible Authentication Protocol (EAP)',
    [
      [
        '/assignments/eapsimaka-numbers#eapsimaka-numbers-2',
        'Attribute Types (Non-Skippable Attributes 0-127)',
      ],
      [
        '/assignments/eapsimaka-numbers#eapsimaka-numbers-3',
        'Attribute Types (Skippable Attributes 128-255)',
      ],
      ['/assignments/eap-numbers#eap-finish-re-auth-flags', 'EAP Finish/Re-auth Flags'],
      ['/assignments/eap-numbers#eap-numbers-2', 'EAP Initiate and Finish Attributes'],
      ['/assignments/eap-numbers#eap-initiate-re-auth-flags', 'EAP Initiate/Re-auth Flags'],
      [
        '/assignments/eap-numbers#eap-initiate-re-auth-start-flags',
        'EAP Initiate/Re-auth-Start Flags',
      ],
      ['/assignments/eap-numbers#eap-lower-layers', 'EAP Lower Layers'],
      ['/assignments/eap-numbers#eap-provisioning-ids', 'EAP Provisioning Identifiers'],
      [
        '/assignments/eapsimaka-numbers#eapsimaka-numbers-7',
        "EAP-AKA' AT_KDF Key Derivation Function Values",
      ],
      [
        '/assignments/eapsimaka-numbers#eap-aka-at-kdf-fs-key-derivation-function',
        "EAP-AKA' AT_KDF_FS Key Derivation Function Values",
      ],
      ['/assignments/eap-numbers#eap-numbers-10', 'EAP-TTLS AVP Usage'],
      ['/assignments/eap-psk-parameters#eap-psk-parameters-1', 'EXT_Type Numbers'],
      ['/assignments/eap-numbers#eap-numbers-8', 'Message Types'],
      ['/assignments/eap-numbers#eap-numbers-4', 'Method Types'],
      ['/assignments/eap-numbers#eap-numbers-1', 'Packet Codes'],
      ['/assignments/eap-numbers#eap-numbers-9', 'Re-authentication Cryptosuites'],
      ['/assignments/eapsimaka-numbers#eapsimaka-numbers-1', 'Subtypes'],
      [
        '/assignments/eapsimaka-numbers#trusted-non-3gpp-access',
        'Trusted Non-3GPP Access EAP Parameters',
      ],
    ],
  ],
  [
    'Generalized Multi-Protocol Label Switching (GMPLS) Signaling Parameters',
    [['/assignments/gmpls-sig-parameters#gmpls-sig-parameters-7', 'Interface_ID Types']],
  ],
  [
    'GMPLS Routing Parameters for WSON',
    [
      [
        '/assignments/gmpls-wson#interface-label-stack-address-type',
        'Types for Subfields of WSON Resource Block Information Registry',
      ],
    ],
  ],
  [
    'Hypertext Transfer Protocol (HTTP) Authentication Control Parameters',
    [
      [
        '/assignments/http-authentication-control-parameters#mutual-authentication-host-validation-methods',
        'HTTP Mutual Authentication Host Validation Methods',
      ],
    ],
  ],
  [
    'Hypertext Transfer Protocol (HTTP) Method Registry',
    [['/assignments/http-methods#methods', 'HTTP Method Registry']],
  ],
  [
    'IANA OUI Ethernet Numbers',
    [
      [
        '/assignments/ethernet-numbers#iana-lldp-tlv-subtypes',
        'IANA Link Layer Discovery Protocol (LLDP) TLV Subtypes',
      ],
      ['/assignments/ethernet-numbers#ethernet-numbers-6', 'SNAP Protocol Numbers'],
    ],
  ],
  [
    'IANA-Maintained MIBs',
    [['/assignments/mib-modules#ianastoragemediatype-mib', 'IANA-STORAGE-MEDIA-TYPE-MIB']],
  ],
  ['IEEE 802 Numbers', [['/assignments/ieee-802-numbers#ieee-802-numbers-1', 'Ethertypes']]],
  [
    'Interface Parameters',
    [
      ['/assignments/smi-numbers#smi-numbers-5', 'Interface Types (ifType)'],
      ['/assignments/smi-numbers#smi-numbers-6', 'Tunnel Types (tunnelType)'],
    ],
  ],
  [
    'Internet Control Message Protocol (ICMP) Parameters',
    [['/assignments/icmp-parameters#icmp-parameters-types', 'ICMP Type Numbers']],
  ],
  [
    'Internet Control Message Protocol version 6 (ICMPv6) Parameters',
    [['/assignments/icmpv6-parameters#icmpv6-parameters-2', 'ICMPv6 "type" Numbers']],
  ],
  [
    'Internet Group Management Protocol (IGMP) Type Numbers',
    [
      ['/assignments/igmp-type-numbers#igmp-type-numbers-2', '"Code" Fields'],
      ['/assignments/igmp-type-numbers#igmp-type-numbers-1', 'IGMP Type Numbers'],
      ['/assignments/igmp-type-numbers#igmp-mld-extension-types', 'IGMP/MLD Extension Types'],
      [
        '/assignments/igmp-type-numbers#igmp-mld-query-message-flags',
        'IGMP/MLD Query Message Flags',
      ],
      [
        '/assignments/igmp-type-numbers#igmp-mld-report-message-flags',
        'IGMP/MLD Report Message Flags',
      ],
    ],
  ],
  [
    'Internet Protocol Version 4 (IPv4) Parameters',
    [['/assignments/ip-parameters#ip-parameters-1', 'IP Option Numbers']],
  ],
  [
    'IPS Protocol# (Protocol Number) Field',
    [['/assignments/ips-protocols#ips-protocols-2', 'Protocol# (Protocol Number) Field']],
  ],
  [
    'Licklider Transmission Protocol (LTP) Parameters',
    [['/assignments/ltp-parameters#engine-numbers', 'LTP Engine Numbers']],
  ],
  [
    'Lightweight Directory Access Protocol (LDAP) Parameters',
    [
      [
        '/assignments/ldap-parameters#ldap-parameters-1',
        'Internet Directory Numbers (iso.org.dod.internet.directory [1.3.6.1.1.])',
      ],
    ],
  ],
  [
    'Locator/ID Separation Protocol (LISP) Parameters',
    [['/assignments/lisp-parameters#lisp-algorithm-id-numbers', 'LISP Algorithm ID Numbers']],
  ],
  [
    '"Magic Numbers" for ISAKMP Protocol',
    [
      ['/assignments/isakmp-registry#isakmp-registry-7', 'IPSEC AH Transform Identifiers'],
      ['/assignments/isakmp-registry#isakmp-registry-9', 'IPSEC ESP Transform Identifiers'],
      ['/assignments/isakmp-registry#isakmp-registry-31', 'IPSEC Identification Type'],
      ['/assignments/isakmp-registry#isakmp-registry-11', 'IPSEC IPCOMP Transform Identifiers'],
      ['/assignments/isakmp-registry#isakmp-registry-5', 'IPSEC ISAKMP Transform Identifiers'],
      ['/assignments/isakmp-registry#isakmp-registry-29', 'IPSEC Labeled Domain Identifiers'],
      ['/assignments/isakmp-registry#isakmp-registry-32', 'IPSEC Notify Message Types'],
      ['/assignments/isakmp-registry#isakmp-registry-13', 'IPSEC Security Association Attributes'],
      ['/assignments/isakmp-registry#isakmp-registry-3', 'IPSEC Security Protocol Identifiers'],
      ['/assignments/isakmp-registry#isakmp-registry-1', 'IPSEC Situation Definition'],
    ],
  ],
  [
    'Media Control Channel Framework Parameters',
    [
      [
        '/assignments/media-control-channel#ivr-prompt',
        'IVR Prompt Variable Type for Control Packages',
      ],
    ],
  ],
  [
    'Media Resource Control Protocol Version 2 (MRCPv2) Parameters',
    [['/assignments/mrcpv2-parameters#resource-types', 'MRCPv2 Resource Types']],
  ],
  [
    'Multiprotocol Label Switching Architecture (MPLS)',
    [
      [
        '/assignments/mpls-lsp-ping-parameters#interface-label-stack-address-type',
        'Interface and Label Stack and Detailed Interface and Label Stack Address Types',
      ],
    ],
  ],
  [
    'Multipurpose Internet Mail Extensions (MIME) and Media Types',
    [
      ['/assignments/access-types#access-types-1', 'Access Types'],
      [
        '/assignments/media-type-sub-parameters#cms-encapsulating',
        'CMS Encapsulating Content Types',
      ],
      ['/assignments/media-type-sub-parameters#cms-inner', 'CMS Inner Content Types'],
      [
        '/assignments/audio-telephone-event-registry#audio-telephone-event-registry-1',
        'Event Code Registry',
      ],
      ['/assignments/markdown-variants#variants', 'Markdown Variants'],
      ['/assignments/media-types', 'Media Types'],
      ['/assignments/media-types-parameters#media-types-parameters-1', 'MIME to X.400 Table'],
      [
        '/assignments/media-types-parameters#media-types-parameters-3',
        'MIME to X.400 Table - Extended Body Part',
      ],
      [
        '/assignments/media-type-sub-parameters#smime',
        'Parameter Values for the smime-type Parameter',
      ],
      [
        '/assignments/provisional-standard-media-types#provisional-standard-types',
        'Provisional Standard Media Type Registry',
      ],
      ['/assignments/media-type-sub-parameters#report-type', 'Report Types'],
      [
        '/assignments/iesg-recognized-organizations#organizations',
        'Standards-related organizations that have registered Media Types in the Standards Tree',
      ],
      [
        '/assignments/media-type-structured-suffix#structured-syntax-suffix',
        'Structured Syntax Suffixes',
      ],
      [
        '/assignments/media-type-sub-parameters#media-type-sub-parameters-18',
        'Sub-Parameter Registry for application/aif+cbor and application/aif+json',
      ],
      [
        '/assignments/media-type-sub-parameters#media-type-sub-parameters-17',
        'Sub-parameter Registry for application/mbox',
      ],
      [
        '/assignments/media-type-sub-parameters#media-type-sub-parameters-8',
        'Sub-Parameter Registry for audio/rtp-midi',
      ],
      [
        '/assignments/media-type-sub-parameters#media-type-sub-parameters-2',
        'Sub-Parameter Registry for mode=rtp-midi of audio/mpeg4-generic',
      ],
      [
        '/assignments/media-type-sub-parameters#media-type-sub-parameters-14',
        'Sub-Parameter Registry for video/raw',
      ],
      [
        '/assignments/media-type-sub-parameters#media-type-sub-parameters-1',
        'Sub-Parameter Registry video/mpeg4-generic, audio/mpeg4-generic and application/mpeg4-generic',
      ],
      [
        '/assignments/text-directory-registrations#text-directory-registrations-3',
        'text/directory Parameters',
      ],
      [
        '/assignments/text-directory-registrations#text-directory-registrations-1',
        'text/directory Profiles',
      ],
      [
        '/assignments/text-directory-registrations#text-directory-registrations-2',
        'text/directory Types',
      ],
      ['/assignments/top-level-media-types#top-level-media-type-names', 'Top-Level Media Types'],
      [
        '/assignments/media-types-parameters#media-types-parameters-2',
        'X.400 to MIME Table - Basic Body Parts',
      ],
    ],
  ],
  [
    'Novell Service Advisor Protocol (SAP) Numbers - Novell Object Types',
    [['/assignments/novell-sap-numbers#novell-sap-numbers-1', 'Novell Object Type']],
  ],
  [
    'One-Way Active Measurement Protocol (OWAMP) Parameters',
    [['/assignments/owamp-parameters#control-command-numbers', 'OWAMP-Control Command Numbers']],
  ],
  [
    'Path Computation Element Protocol (PCEP) Numbers',
    [
      ['/assignments/pcep#association-flag-field', 'ASSOCIATION Flag Field'],
      ['/assignments/pcep#association-type-field', 'ASSOCIATION Type Field'],
      [
        '/assignments/pcep#auto-bandwidth-attributes-sub-tlv',
        'AUTO-BANDWIDTH-ATTRIBUTES Sub-TLV Types',
      ],
      [
        '/assignments/pcep#auto-bandwidth-capability-tlv-flag-field',
        'AUTO-BANDWIDTH-CAPABILITY TLV Flag Field',
      ],
      [
        '/assignments/pcep#bidirectional-lsp-association-group',
        'Bidirectional LSP Association Group TLV Flag Field',
      ],
      ['/assignments/pcep#bpi-object-error-code-field', 'BPI Object Error Code Field'],
      ['/assignments/pcep#bpi-object-flag-field', 'BPI Object Flag Field'],
      ['/assignments/pcep#bpi-object-status-code-field', 'BPI Object Status Code Field'],
      ['/assignments/pcep#bu-object-type-field', 'BU Object Type Field'],
      [
        '/assignments/pcep#cci-object-flag-field-mpls-label',
        'CCI Object Flag Field for MPLS Label',
      ],
      ['/assignments/pcep#cci-object-flag-field-native-ip', 'CCI Object Flag Field for Native IP'],
      ['/assignments/pcep#close-object-flag-field', 'CLOSE Object Flag Field'],
      ['/assignments/pcep#close-object-reason-field', 'CLOSE Object Reason Field'],
      [
        '/assignments/pcep#disjointness-configuration-tlv-flag-field',
        'DISJOINTNESS-CONFIGURATION TLV Flag Field',
      ],
      ['/assignments/pcep#domain-id-tlv-domain-type', 'Domain-ID TLV Domain Type'],
      ['/assignments/pcep#flags-multipath-cap-tlv', 'Flags in MULTIPATH-CAP TLV'],
      [
        '/assignments/pcep#flags-multipath-forward-class-tlv',
        'Flags in MULTIPATH-FORWARD-CLASS TLV',
      ],
      ['/assignments/pcep#flags-multipath-oppdir-path-tlv', 'Flags in MULTIPATH-OPPDIR-PATH TLV'],
      ['/assignments/pcep#flags-path-attrib-object', 'Flags in PATH-ATTRIB Object'],
      ['/assignments/pcep#flowspec-object-flag-field', 'FLOWSPEC Object Flag Field'],
      ['/assignments/pcep#generalized-endpoint-type', 'Generalized Endpoint Types'],
      ['/assignments/pcep#gmpls-capability-tlv-flag-field', 'GMPLS-CAPABILITY TLV Flag Field'],
      ['/assignments/pcep#h-pce-capability-tlv-flag-field', 'H-PCE-CAPABILITY TLV Flag Field'],
      ['/assignments/pcep#h-pce-flag-tlv-flag-field', 'H-PCE-FLAG TLV Flag Field'],
      [
        '/assignments/pcep#inter-layer-object-path-property-bits',
        'Inter-Layer Object Path Property Bits',
      ],
      ['/assignments/pcep#iro-subobject', 'IRO Subobjects'],
      ['/assignments/pcep#load-balancing-object-flag-field', 'LOAD-BALANCING Object Flag Field'],
      [
        '/assignments/pcep#lsp-exclusion-sub-object-flag-field',
        'LSP Exclusion Subobject Flag Field',
      ],
      ['/assignments/pcep#lsp-object-flag-field', 'LSP Object Flag Field'],
      [
        '/assignments/pcep#lsp-error-code-tlv-error-code-field',
        'LSP-ERROR-CODE TLV Error Code Field',
      ],
      ['/assignments/pcep#lsp-extended-flag-tlv-flags', 'LSP-EXTENDED-FLAG TLV Flag Field'],
      ['/assignments/pcep#lspa-object-flag-field', 'LSPA Object Flag Field'],
      ['/assignments/pcep#metric-object-flag-field', 'METRIC Object Flag Field'],
      ['/assignments/pcep#metric-object-t-field', 'METRIC Object T Field'],
      ['/assignments/pcep#monitoring-object', 'MONITORING Object Flag Field'],
      ['/assignments/pcep#no-path-object-flag-field', 'NO-PATH Object Flag Field'],
      ['/assignments/pcep#no-path-object-ni-field', 'NO-PATH Object NI Field'],
      ['/assignments/pcep#no-path-vector-tlv', 'NO-PATH-VECTOR TLV Flag Field'],
      ['/assignments/pcep#notification-object', 'Notification Object'],
      ['/assignments/pcep#notification-object-flag-field', 'Notification Object Flag Field'],
      ['/assignments/pcep#of', 'Objective Function'],
      ['/assignments/pcep#open-object-flag-field', 'Open Object Flag Field'],
      ['/assignments/pcep#overload-object', 'OVERLOAD Object Flag field'],
      [
        '/assignments/pcep#path-protection-association-group-tlv-flag-field',
        'Path Protection Association Group TLV Flag Field',
      ],
      ['/assignments/pcep#path-key-subobject', 'PATH-KEY Subobjects'],
      ['/assignments/pcep#path-modification-tlv-flag-field', 'PATH-MODIFICATION TLV Flag Field'],
      [
        '/assignments/pcep#path-setup-type-capability-sub-tlv-type-indicators',
        'PATH-SETUP-TYPE-CAPABILITY Sub-TLV Type Indicators',
      ],
      ['/assignments/pcep#pcecc-capability', 'PCECC-CAPABILITY sub-TLV'],
      [
        '/assignments/pcep#flow-specification-tlv-type-indicators',
        'PCEP Flow Specification TLV Type Indicators',
      ],
      ['/assignments/pcep#pcep-message-common-header', 'PCEP Message Common Header Flag Field'],
      ['/assignments/pcep#pcep-messages', 'PCEP Messages'],
      ['/assignments/pcep#pcep-objects', 'PCEP Objects'],
      ['/assignments/pcep#pcep-path-setup-types', 'PCEP Path Setup Types'],
      ['/assignments/pcep#pcep-sr-ero-nai-types', 'PCEP SR-ERO NAI Types'],
      ['/assignments/pcep#pcep-srv6-ero-nai-types', 'PCEP SRv6-ERO NAI Types'],
      ['/assignments/pcep#pcep-tlv-type-indicators', 'PCEP TLV Type Indicators'],
      ['/assignments/pcep#pcep-error-object', 'PCEP-ERROR Object Error Types and Values'],
      ['/assignments/pcep#pcep-error-object-flag-field', 'PCEP-ERROR Object Flag Field'],
      ['/assignments/pcep#proc-time-object', 'PROC-TIME Object Flag Field'],
      ['/assignments/pcep#rp-object', 'RP Object Flag Field'],
      ['/assignments/pcep#s2ls-object-flag-field', 'S2LS Object Flag Field'],
      [
        '/assignments/pcep#sched-pd-lsp-attribute-tlv-opt-field',
        'SCHED-PD-LSP-ATTRIBUTE TLV Opt Field',
      ],
      ['/assignments/pcep#schedule-tlvs-flag-field', 'Schedule TLVs Flag Field'],
      ['/assignments/pcep#sr-capability-flag-field', 'SR Capability Flag Field'],
      [
        '/assignments/pcep#sr-policy-capability-tlv-flag-field',
        'SR Policy Capability TLV Flag Field',
      ],
      [
        '/assignments/pcep#sr-policy-invalidation-configuration-flags',
        'SR Policy Invalidation Configuration Flags',
      ],
      [
        '/assignments/pcep#sr-policy-invalidation-operational-flags',
        'SR Policy Invalidation Operational Flags',
      ],
      ['/assignments/pcep#sr-ero-flag-field', 'SR-ERO Flag Field'],
      ['/assignments/pcep#srp-object-flag-field', 'SRP Object Flag Field'],
      ['/assignments/pcep#srv6-capability-flag-field', 'SRv6 Capability Flag Field'],
      ['/assignments/pcep#srv6-ero-flag-field', 'SRv6-ERO Flag Field'],
      [
        '/assignments/pcep#stateful-pce-capability-tlv-flag-field',
        'STATEFUL-PCE-CAPABILITY TLV Flag Field',
      ],
      ['/assignments/pcep#svec-object-flag-field', 'SVEC Object Flag Field'],
      ['/assignments/pcep#te-path-binding-tlv-bt', 'TE-PATH-BINDING TLV BT Field'],
      ['/assignments/pcep#te-path-binding-tlv-flags', 'TE-PATH-BINDING TLV Flag Field'],
      ['/assignments/pcep#wa-object-flag-field', 'WA Object Flag Field'],
      [
        '/assignments/pcep#wavelength-allocation-tlv-flag-field',
        'Wavelength Allocation TLV Flag Field',
      ],
      [
        '/assignments/pcep#wavelength-restriction-constraint-tlv-action-values',
        'Wavelength Restriction TLV Action Values',
      ],
      ['/assignments/pcep#xro-flag-field', 'XRO Flag Field'],
      ['/assignments/pcep#xro-subobject', 'XRO Subobjects'],
    ],
  ],
  [
    'Peer-to-Peer Streaming Peer Protocol (PPSPP)',
    [['/assignments/ppspp#version', 'PPSP Peer Protocol Version Number Registry']],
  ],
  [
    'Peer-to-Peer Streaming Tracker Protocol (PPSTP)',
    [['/assignments/ppsp-tp#version', 'PPSTP Version Number Registry']],
  ],
  [
    'Point-to-Point (PPP) Protocol Field Assignments',
    [
      [
        '/assignments/ppp-numbers#ppp-numbers-31',
        'IP Header Compression Configuration Option Suboption Types',
      ],
      ['/assignments/ppp-numbers#ppp-numbers-29', 'IP-Compression-Protocol Types'],
      ['/assignments/ppp-numbers#ppp-numbers-30', 'IPv6-Compression-Protocol Types'],
      [
        '/assignments/ppp-numbers#ppp-numbers-22',
        'NetBIOS Frames Control Protocol (NBFCP) Configuration Options',
      ],
      ['/assignments/ppp-numbers#ppp-numbers-19', 'PPP (IPXCP) Configuration Options'],
      ['/assignments/ppp-numbers#ppp-numbers-13', 'PPP ATCP Configuration Option Types'],
      ['/assignments/ppp-numbers#ppp-numbers-9', 'PPP Authentication Algorithms'],
      ['/assignments/ppp-numbers#ppp-numbers-15', 'PPP Banyan Vines Configuration Option Types'],
      ['/assignments/ppp-numbers#ppp-numbers-16', 'PPP Bridging Configuration Option Types'],
      ['/assignments/ppp-numbers#ppp-numbers-17', 'PPP Bridging MAC Types'],
      ['/assignments/ppp-numbers#ppp-numbers-18', 'PPP Bridging Spanning Tree'],
      ['/assignments/ppp-numbers#ppp-numbers-7', 'PPP CCP Configuration Option Types'],
      ['/assignments/ppp-numbers#ppp-numbers-2', 'PPP DLL Protocol Numbers'],
      ['/assignments/ppp-numbers#ppp-numbers-25', 'PPP EAP Request/Response Types'],
      ['/assignments/ppp-numbers#ppp-numbers-6', 'PPP ECP Configuration Option Types'],
      ['/assignments/ppp-numbers#ppp-numbers-27', 'PPP IPCP Configuration Option Types'],
      ['/assignments/ppp-numbers#ppp-numbers-28', 'PPP IPv6CP Configuration Options'],
      ['/assignments/ppp-numbers#ppp-numbers-12', 'PPP LCP Callback Operation Fields'],
      ['/assignments/ppp-numbers#ppp-numbers-4', 'PPP LCP Configuration Option Types'],
      ['/assignments/ppp-numbers#ppp-numbers-10', 'PPP LCP FCS-Alternatives'],
      [
        '/assignments/ppp-numbers#ppp-numbers-3',
        'PPP Link Control Protocol (LCP) and Internet Protocol Control Protocol (IPCP) Codes',
      ],
      ['/assignments/ppp-numbers#ppp-numbers-11', 'PPP Multilink Endpoint Discriminator Class'],
      ['/assignments/ppp-numbers#ppp-numbers-14', 'PPP OSINLCP Configuration Option Types'],
      ['/assignments/ppp-numbers#ppp-numbers-33', 'PPP Over Ethernet Versions'],
      ['/assignments/ppp-numbers#ppp-numbers-8', 'PPP SDCP Configuration Options'],
      ['/assignments/ppp-numbers#ppp-numbers-5', 'PPP TNCP Configuration Option Types'],
      ['/assignments/ppp-numbers#ppp-numbers-26', 'PPP Vendor Specific OUI Options'],
      [
        '/assignments/ppp-numbers#ppp-numbers-32',
        'ROHC Configuration Option Suboption Identifier Values',
      ],
    ],
  ],
  [
    'Probabilistic Routing Protocol using History of Encounters and Transitivity (PRoPHET)',
    [['/assignments/prophet#dtn-routing-protocol-number', 'DTN Routing Protocol Number']],
  ],
  [
    'Protocol Numbers',
    [['/assignments/protocol-numbers#protocol-numbers-1', 'Assigned Internet Protocol Numbers']],
  ],
  [
    'Pseudowire Name Spaces (PWE3)',
    [
      [
        '/assignments/pwe3-parameters#pwe3-parameters-4',
        'Pseudowire Interface Parameters Sub-TLV type Registry',
      ],
    ],
  ],
  [
    'Real-Time Transport Protocol (RTP) Parameters',
    [['/assignments/rtp-parameters#rtp-parameters-2', 'RTP Payload Format Media Types']],
  ],
  [
    'Registration Data Access Protocol (RDAP)',
    [['/assignments/rdap-asn', 'Bootstrap Service Registry for AS Number Space']],
  ],
  [
    'Resource Reservation Protocol (RSVP) Parameters',
    [
      [
        '/assignments/rsvp-parameters#rsvp-parameters-4',
        'Class Names, Class Numbers, and Class Types',
      ],
    ],
  ],
  [
    'Secure Shell (SSH) Protocol Parameters',
    [
      ['/assignments/ssh-parameters#ssh-parameters-1', 'Message Numbers'],
      [
        '/assignments/ssh-parameters#ssh-agent-key-constraint-numbers',
        'SSH Agent Key Constraint Numbers',
      ],
      [
        '/assignments/ssh-parameters#ssh-agent-protocol-message-type-numbers',
        'SSH Agent Protocol Message Type Numbers',
      ],
    ],
  ],
  [
    'Selective P-Multicast Service Interface (S-PMSI) Parameters',
    [['/assignments/s-pmsi-parameters#s-pmsi-parameters-1', 'S-PMSI Join Message Type Field']],
  ],
  [
    'Server Cache Synchronization Protocol (SCSP) Parameters',
    [['/assignments/scsp-numbers#scsp-numbers-1', 'Protocol IDs']],
  ],
  [
    'Service Location Protocol, Version 2 (SLPv2) Error Numbers',
    [['/assignments/svrloc-error-numbers#svrloc-error-numbers-1', 'Error Numbers']],
  ],
  [
    'Service Names and Transport Protocol Port Numbers',
    [
      [
        '/assignments/service-names-port-numbers',
        'Service Name and Transport Protocol Port Number Registry',
      ],
    ],
  ],
  [
    'Signaling User Adaptation Layer Assignments',
    [
      [
        '/assignments/sigtran-adapt#sigtran-adapt-12',
        'Message Types - Interface Identifier Management (IIM) Messages (Value 10)',
      ],
    ],
  ],
  [
    'Simple Network Management Protocol (SNMP) Number Spaces',
    [
      ['/assignments/snmp-number-spaces#snmp-number-spaces-2', 'Message Processing Models'],
      ['/assignments/snmp-number-spaces#snmp-number-spaces-1', 'Security Models'],
      ['/assignments/snmp-number-spaces#snmp-number-spaces-7', 'SNMP Transport Domains'],
      ['/assignments/snmp-number-spaces#snmp-number-spaces-5', 'SnmpAuthProtocols'],
      ['/assignments/snmp-number-spaces#snmp-number-spaces-4', 'SnmpEngineID Formats'],
      ['/assignments/snmp-number-spaces#snmp-number-spaces-6', 'SnmpPrivProtocols'],
    ],
  ],
  [
    'Structure of Management Information (SMI) Numbers (MIB Module Registrations)',
    [
      ['/assignments/smi-numbers#smi-numbers-5', 'Interface Types (ifType)'],
      ['/assignments/smi-numbers#smi-numbers-6', 'Tunnel Types (tunnelType)'],
    ],
  ],
  [
    'The Extensible Authentication Protocol Mechanism for the Generic Security Service Application Programming Interface (GSS-EAP) Parameters',
    [['/assignments/gss-eap-parameters#subtoken-types', 'GSS-EAP Subtoken Types']],
  ],
  [
    'Transmission Control Protocol (TCP) Parameters',
    [
      ['/assignments/tcp-parameters#tcp-parameters-2', 'TCP Alternate Checksum Numbers'],
      ['/assignments/tcp-parameters#tcp-parameters-1', 'TCP Option Kind Numbers'],
    ],
  ],
  [
    'Transparent Interconnection of Lots of Links (TRILL) Parameters',
    [['/assignments/trill-parameters#trill-ethertypes', 'TRILL Ethertypes']],
  ],
  [
    'Transport Layer Security (TLS)',
    [
      ['/assignments/tls-parameters#tls-parameters-4', 'TLS Cipher Suites'],
      [
        '/assignments/tls-ech-configuration-extensions#tls-echconfig-extension',
        'TLS ECHConfig Extension',
      ],
      [
        '/assignments/tls-extensiontype-values#tls-extensiontype-values-1',
        'TLS ExtensionType Values',
      ],
    ],
  ],
  [
    'Two-way Active Measurement Protocol (TWAMP) Parameters',
    [['/assignments/twamp-parameters#twamp-parameters-1', 'TWAMP-Control Command Numbers']],
  ],
  ['User Datagram Protocol (UDP)', [['/assignments/udp#udp-options', 'UDP Option Kind Numbers']]],
  [
    'WebSocket Protocol Registries',
    [
      ['/assignments/websocket#close-code-number', 'WebSocket Close Code Number Registry'],
      ['/assignments/websocket#version-number', 'WebSocket Version Number Registry'],
    ],
  ],
  [
    'Xerox Network System (XNS) Protocol Types',
    [
      [
        '/assignments/xns-protocol-types#xns-protocol-types-1',
        'Assigned well-known socket numbers',
      ],
    ],
  ],
  [
    'YANG Modules',
    [
      ['/assignments/iana-dns-class-rr-type', 'iana-dns-class-rr-type YANG Module'],
      ['/assignments/iana-tls-cipher-suite-algs', 'iana-tls-cipher-suite-algs YANG Module'],
    ],
  ],
];

const escapeHtml = (text: string) =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/**
 * The excerpt as an index page that clears the parse floor: `fillerIds` filler
 * registry ids of four entries each under a filler category (no word of
 * {@link LIVE_INDEX_QUERIES} in them), then the excerpt.
 */
export function liveIndexHtml(fillerIds = 520): string {
  const rows: string[] = [categoryRow('Filler Category')];
  for (let id = 0; id < fillerIds; id++) {
    for (let entry = 0; entry < 4; entry++) {
      rows.push(
        entryRow({
          href: `/assignments/filler-${id}${entry === 0 ? '' : `#part-${entry}`}`,
          title: `Filler ${id} part ${entry}`,
        }),
      );
    }
  }
  for (const [category, entries] of LIVE_INDEX_GROUPS) {
    rows.push(categoryRow(escapeHtml(category)));
    for (const [href, title] of entries) rows.push(entryRow({ href, title: escapeHtml(title) }));
  }
  return indexPage(...rows);
}
